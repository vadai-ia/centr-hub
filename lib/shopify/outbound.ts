import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { getOrganizationById } from "@/lib/db/organizations";
import { ShopifyApiError, shopifyRest } from "@/lib/shopify/admin-client";
import { markOutboundWrite } from "@/lib/services/sync-loop-defense";
import { recordAuditEvent } from "@/lib/db/operational";
import { PLATFORM_ORIGIN_MARKER } from "@/lib/constants";
import type { UUID } from "@/lib/types/database";

/**
 * Cliente outbound a Shopify Admin API (Sección 3.6 + asimetría v5.1).
 *
 * Capacidades en M3:
 *   - updateCustomer(...)        — PUT /customers/{id}.json
 *   - addCustomerTag(...)        — PUT /customers/{id}.json (append tag)
 *   - removeCustomerTag(...)     — PUT /customers/{id}.json (filter out tag)
 *   - createCustomer(...)        — POST /customers.json (EXPUESTO PARA M6,
 *                                  no se invoca desde workers de M3)
 *
 * Cada llamada:
 *   1. Verifica `organizations.backfill_in_progress = false` —
 *      durante backfill se suprime para no saturar Shopify con
 *      escrituras de vuelta (Sección "Supresión de llamadas
 *      salientes durante backfill").
 *   2. Marca el contact local con `markOutboundWrite` ANTES de
 *      invocar el grant (R11 defensa anti-bucle).
 *   3. Realiza la llamada con `shopifyRest`. ShopifyApiError ya
 *      indica si es retriable.
 *   4. Si el ID Shopify devuelto difiere del esperado (raro), se
 *      registra audit log para diagnóstico.
 *
 * Importante (R11): la marca outbound se aplica ANTES de la llamada
 * para no perder el rastro si Shopify procesa y devuelve webhook
 * en <100ms. El cost downside (si la llamada falla) es que el
 * contact tiene last_modified_at adelantado — el siguiente webhook
 * legítimo con `updated_at` levemente posterior aún se aplica
 * correctamente (LWW lo gestiona).
 */

const PLATFORM_NOTE_HEADER = `[${PLATFORM_ORIGIN_MARKER}-origin]`;

export interface OutboundContext {
  organizationId: UUID;
  shopDomain: string;
}

async function ensureOutboundAllowed(orgId: UUID): Promise<void> {
  const org = await getOrganizationById(orgId);
  if (!org) {
    throw new Error(`outbound: organización ${orgId} no encontrada`);
  }
  // Lee directamente del row tipado: backfill_in_progress es columna
  // nueva v5.1 (migración 0013) presente en runtime pero no en el
  // tipo TS hand-written. Cast defensivo.
  const flag = (org as unknown as { backfill_in_progress?: boolean }).backfill_in_progress;
  if (flag === true) {
    throw new BackfillSuppressedError(orgId);
  }
}

export class BackfillSuppressedError extends Error {
  public readonly retriable = false;
  constructor(organizationId: UUID) {
    super(
      `outbound suprimido: org ${organizationId} tiene backfill_in_progress=true`,
    );
    this.name = "BackfillSuppressedError";
  }
}

// ============================================================
// updateCustomer — actualización de campos
// ============================================================

export interface UpdateCustomerInput {
  ctx: OutboundContext;
  contactId: UUID;
  shopifyCustomerId: string;
  /**
   * SOLO campos escalares del customer. La dirección NO va aquí: el
   * PUT de customer con un `addresses[]` sin `id` APENDA una dirección
   * nueva en vez de actualizar la existente (Shopify la trata como
   * alta). La sincronización de dirección vive en
   * `syncCustomerDefaultAddress` (endpoint dedicado por `address_id`).
   * Ver ERRORES.md "Edición de dirección desde la plataforma duplicaba
   * la dirección en Shopify".
   */
  fields: Partial<{
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    note: string | null;
  }>;
}

export async function updateCustomer(input: UpdateCustomerInput): Promise<void> {
  await ensureOutboundAllowed(input.ctx.organizationId);
  await markOutboundWrite({
    contactId: input.contactId,
    source: PLATFORM_ORIGIN_MARKER,
  });

  const body = {
    customer: {
      id: Number(input.shopifyCustomerId),
      ...input.fields,
      note: composeNoteWithMarker(input.fields.note ?? null),
    },
  };

  await shopifyRest(input.ctx, "PUT", `/customers/${input.shopifyCustomerId}.json`, body);
  await recordAuditEvent({
    actorUserId: null,
    eventType: "shopify_customer_updated_outbound",
    entityType: "contact",
    entityId: input.contactId,
    payload: { shopify_customer_id: input.shopifyCustomerId },
  });
}

// ============================================================
// syncCustomerDefaultAddress — actualización de dirección EN SITIO
// ============================================================

/** Forma mínima de un Shopify Customer Address que nos interesa. */
interface ShopifyCustomerAddress {
  id: number | string;
  default?: boolean;
  [key: string]: unknown;
}

export interface SyncCustomerAddressInput {
  ctx: OutboundContext;
  contactId: UUID;
  shopifyCustomerId: string;
  /**
   * Dirección del maestro YA mapeada al Address de Shopify
   * (`structuredAddressToShopify` — claves canónicas + country_code/
   * province_code). Si es null/vacía → no-op (este fix NO borra; vaciar
   * la dirección en el maestro queda fuera de alcance — gap R3 conocido,
   * ver ERRORES.md).
   */
  address: Record<string, string> | null;
}

export interface SyncCustomerAddressResult {
  action: "updated" | "created" | "skipped";
  addressId: string | null;
}

/**
 * Sincroniza la dirección del maestro a Shopify ACTUALIZANDO la
 * dirección predeterminada existente por su `address_id`, resuelto
 * vía GET en el momento (no se confía en un id guardado localmente —
 * `parseStoredAddress` lo descarta y los contactos nacidos en la
 * plataforma nunca lo tuvieron).
 *
 * Camino correcto del contrato de Shopify (la causa del bug de
 * duplicación era usar el array `addresses` del PUT de customer):
 *   - Existe dirección (default o, si no hay default marcada, la
 *     primera) → `PUT /customers/{id}/addresses/{address_id}.json`
 *     (actualiza EN SITIO, no crea).
 *   - No existe ninguna → `POST /customers/{id}/addresses.json` +
 *     `PUT .../addresses/{new_id}/default.json` (alta + marca default).
 *
 * R11 (anti-bucle): `markOutboundWrite` ANTES de escribir; el eco
 * `customers/update` que Shopify emite cae en la ventana de 30s del
 * marker (mismo contacto) y se descarta en M3 (`discardIfOwnEcho`).
 *
 * Idempotente: un retry de Inngest re-GETea, encuentra la default ya
 * actualizada y la re-escribe con el mismo valor (sin duplicar).
 */
export async function syncCustomerDefaultAddress(
  input: SyncCustomerAddressInput,
): Promise<SyncCustomerAddressResult> {
  if (!input.address || Object.keys(input.address).length === 0) {
    return { action: "skipped", addressId: null };
  }
  await ensureOutboundAllowed(input.ctx.organizationId);
  await markOutboundWrite({
    contactId: input.contactId,
    source: PLATFORM_ORIGIN_MARKER,
  });

  // 1. Resolver el address_id objetivo desde Shopify (la default, o la
  //    primera si no hay default marcada — así nunca creamos duplicado
  //    cuando ya existe una dirección).
  const fetched = await shopifyRest<{
    customer?: {
      default_address?: ShopifyCustomerAddress | null;
      addresses?: ShopifyCustomerAddress[] | null;
    };
  }>(input.ctx, "GET", `/customers/${input.shopifyCustomerId}.json`);
  const customer = fetched.customer;
  const addresses = customer?.addresses ?? [];
  const target =
    customer?.default_address ?? (addresses.length > 0 ? addresses[0] : null);

  if (target?.id) {
    const addressId = String(target.id);
    await shopifyRest(
      input.ctx,
      "PUT",
      `/customers/${input.shopifyCustomerId}/addresses/${addressId}.json`,
      { address: { id: Number(addressId), ...input.address } },
    );
    await recordAuditEvent({
      actorUserId: null,
      eventType: "shopify_customer_address_synced_outbound",
      entityType: "contact",
      entityId: input.contactId,
      payload: {
        shopify_customer_id: input.shopifyCustomerId,
        address_id: addressId,
        action: "updated",
      },
    });
    return { action: "updated", addressId };
  }

  // 2. No hay ninguna dirección → alta + marca como default.
  const created = await shopifyRest<{
    customer_address?: { id: number | string };
  }>(
    input.ctx,
    "POST",
    `/customers/${input.shopifyCustomerId}/addresses.json`,
    { address: input.address },
  );
  const newId = created?.customer_address?.id
    ? String(created.customer_address.id)
    : null;
  if (newId) {
    await shopifyRest(
      input.ctx,
      "PUT",
      `/customers/${input.shopifyCustomerId}/addresses/${newId}/default.json`,
      {},
    );
  }
  await recordAuditEvent({
    actorUserId: null,
    eventType: "shopify_customer_address_synced_outbound",
    entityType: "contact",
    entityId: input.contactId,
    payload: {
      shopify_customer_id: input.shopifyCustomerId,
      address_id: newId,
      action: "created",
    },
  });
  return { action: "created", addressId: newId };
}

function composeNoteWithMarker(existingNote: string | null): string | null {
  if (existingNote === null) return null;
  if (existingNote.includes(PLATFORM_NOTE_HEADER)) return existingNote;
  return `${PLATFORM_NOTE_HEADER}\n${existingNote}`.slice(0, 5000);
}

// ============================================================
// add / remove customer tag (vendor)
// ============================================================

export interface CustomerTagsInput {
  ctx: OutboundContext;
  contactId: UUID;
  shopifyCustomerId: string;
  currentTags: string[];
  tagsToAdd?: string[];
  tagsToRemove?: string[];
}

export async function updateCustomerTags(input: CustomerTagsInput): Promise<string[]> {
  await ensureOutboundAllowed(input.ctx.organizationId);
  await markOutboundWrite({
    contactId: input.contactId,
    source: PLATFORM_ORIGIN_MARKER,
  });

  const removeSet = new Set(
    (input.tagsToRemove ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t),
  );
  const addList = (input.tagsToAdd ?? []).map((t) => t.trim()).filter((t) => t);

  const filtered = input.currentTags.filter(
    (t) => !removeSet.has(t.trim().toLowerCase()),
  );
  const next = uniquePreservingCase([...filtered, ...addList]);
  const csv = next.join(", ");

  await shopifyRest(input.ctx, "PUT", `/customers/${input.shopifyCustomerId}.json`, {
    customer: { id: Number(input.shopifyCustomerId), tags: csv },
  });
  await recordAuditEvent({
    actorUserId: null,
    eventType: "shopify_customer_tags_updated_outbound",
    entityType: "contact",
    entityId: input.contactId,
    payload: {
      shopify_customer_id: input.shopifyCustomerId,
      added: addList,
      removed: Array.from(removeSet),
      result_tags: next,
    },
  });
  return next;
}

function uniquePreservingCase(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of list) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

// ============================================================
// createCustomer — EXPUESTO para M6 (NO invocado desde M3 workers)
// ============================================================

export interface CreateCustomerInput {
  ctx: OutboundContext;
  contactId: UUID;
  fields: {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    phone: string;                              // Shopify requiere phone o email
    addresses?: Array<Record<string, unknown>>;
    note?: string | null;
    tags?: string | string[] | null;
  };
}

export interface CreateCustomerResult {
  shopifyCustomerId: string;
  alreadyExisted: boolean;
}

/**
 * POST /customers.json con match defensivo por teléfono normalizado.
 *
 * Importante (asimetría v5.1):
 *   - M3 expone esta función para que M6 (botón "Crear contacto en
 *     Shopify") la invoque.
 *   - M3 NO la invoca desde ningún webhook ni worker propio.
 *
 * Match defensivo: antes de crear, busca customer Shopify con el
 * mismo teléfono normalizado. Si existe, retorna su ID y
 * `alreadyExisted=true` para que M6 enlace en lugar de duplicar.
 */
export async function createCustomer(
  input: CreateCustomerInput,
): Promise<CreateCustomerResult> {
  await ensureOutboundAllowed(input.ctx.organizationId);
  await markOutboundWrite({
    contactId: input.contactId,
    source: PLATFORM_ORIGIN_MARKER,
  });

  // 1. Match defensivo por teléfono
  const phoneClean = input.fields.phone;
  const search = await shopifyRest<{
    customers: Array<{ id: number | string; phone?: string | null }>;
  }>(
    input.ctx,
    "GET",
    `/customers/search.json?query=${encodeURIComponent(`phone:${phoneClean}`)}&limit=1`,
  );
  const matchExisting = search.customers?.[0];
  if (matchExisting) {
    const existingId = String(matchExisting.id);
    await recordAuditEvent({
      actorUserId: null,
      eventType: "shopify_customer_matched_existing_on_create",
      entityType: "contact",
      entityId: input.contactId,
      payload: { shopify_customer_id: existingId, phone: phoneClean },
    });
    return { shopifyCustomerId: existingId, alreadyExisted: true };
  }

  // 2. Crear nuevo
  const tagsCsv =
    typeof input.fields.tags === "string"
      ? input.fields.tags
      : Array.isArray(input.fields.tags)
        ? input.fields.tags.join(", ")
        : null;

  const body = {
    customer: {
      first_name: input.fields.first_name ?? null,
      last_name: input.fields.last_name ?? null,
      email: input.fields.email ?? null,
      phone: phoneClean,
      addresses: input.fields.addresses ?? [],
      note: composeNoteWithMarker(input.fields.note ?? null),
      tags: tagsCsv,
    },
  };

  const created = await shopifyRest<{ customer: { id: number | string } }>(
    input.ctx,
    "POST",
    "/customers.json",
    body,
  );
  if (!created?.customer?.id) {
    throw new ShopifyApiError(
      "createCustomer: respuesta sin customer.id",
      500,
      created,
    );
  }
  const id = String(created.customer.id);

  // 3. Persistir enlace del contact al customer recién creado
  const { supabase, organizationId } = getTenantScopedClient();
  await supabase
    .from("contacts")
    .update({ shopify_customer_id: id })
    .eq("id", input.contactId)
    .eq("organization_id", organizationId);

  await recordAuditEvent({
    actorUserId: null,
    eventType: "shopify_customer_created_outbound",
    entityType: "contact",
    entityId: input.contactId,
    payload: { shopify_customer_id: id },
  });
  return { shopifyCustomerId: id, alreadyExisted: false };
}
