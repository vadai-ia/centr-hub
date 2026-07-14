import "server-only";
import {
  whaapyPostventaRest,
  whaapyPostventaRestWith409,
} from "@/lib/whaapy-postventa/client";
import {
  WHAAPY_POSTVENTA_STAGE_NAMES,
  type WhaapyPostventaStageKey,
} from "@/lib/whaapy-postventa/config";
import type { UUID } from "@/lib/types/database";

/**
 * Operaciones concretas contra el Whaapy de Post-venta (webhooks 1, 2, 4).
 *
 * Decisión de match (aprobada):
 *   - El UUID de etapa se resuelve POR NOMBRE vía GET /funnel/v1/stages
 *     (con caché en memoria), no se hardcodea — así el operador reordena
 *     etapas en Whaapy sin romper. Si renombra una de las 3, hay que
 *     actualizar WHAAPY_POSTVENTA_STAGE_NAMES.
 *   - El contacto se matchea POR TELÉFONO (E.164) — el Whaapy de Post-venta
 *     es una instancia independiente, la plataforma no tiene su contact_id.
 */

// ============================================================
// Stage resolver por nombre (con caché en memoria, best-effort)
// ============================================================

interface StageCacheEntry {
  /** name → stage_id */
  byName: Map<string, string>;
  fetchedAtMs: number;
}

const STAGE_CACHE = new Map<UUID, StageCacheEntry>();
/** TTL de la caché de etapas. Las etapas cambian rara vez; 10 min basta. */
const STAGE_CACHE_TTL_MS = 10 * 60 * 1000;

interface WhaapyStagesResponse {
  stages?: Array<{ id?: string; name?: string; position?: number }>;
}

async function loadStageMap(
  organizationId: UUID,
  opts: { forceRefresh?: boolean } = {},
): Promise<Map<string, string>> {
  const cached = STAGE_CACHE.get(organizationId);
  const fresh =
    cached && Date.now() - cached.fetchedAtMs < STAGE_CACHE_TTL_MS;
  if (cached && fresh && !opts.forceRefresh) return cached.byName;

  const res = await whaapyPostventaRest<WhaapyStagesResponse>(
    organizationId,
    "GET",
    "/funnel/v1/stages",
  );
  const byName = new Map<string, string>();
  for (const s of res?.stages ?? []) {
    if (s?.name && s?.id) byName.set(s.name, s.id);
  }
  STAGE_CACHE.set(organizationId, { byName, fetchedAtMs: Date.now() });
  return byName;
}

/**
 * Resuelve el UUID de la etapa destino en el Whaapy de Post-venta a
 * partir de su clave lógica (entregado / casoProblematico / casoResuelto).
 * Si no aparece en la caché, refresca UNA vez antes de rendirse (cubre el
 * caso "etapa creada después de cachear"). Devuelve null si no existe con
 * el nombre esperado → el caller lo trata como error de configuración.
 */
export async function resolvePostventaStageIdByKey(
  organizationId: UUID,
  key: WhaapyPostventaStageKey,
): Promise<string | null> {
  const name = WHAAPY_POSTVENTA_STAGE_NAMES[key];
  let map = await loadStageMap(organizationId);
  let id = map.get(name);
  if (!id) {
    map = await loadStageMap(organizationId, { forceRefresh: true });
    id = map.get(name);
  }
  return id ?? null;
}

// ============================================================
// Contacto: match por teléfono (search)
// ============================================================

interface WhaapySearchResponse {
  contacts?: Array<{
    id?: string;
    phone_number?: string;
    funnel_stage?: { id?: string; name?: string } | null;
  }>;
}

export interface PostventaContactMatch {
  contactId: string;
  /** Etapa actual del contacto en Whaapy (para saltar moves redundantes). */
  currentStageId: string | null;
}

/**
 * Busca el contacto en el Whaapy de Post-venta por teléfono exacto (E.164).
 * Devuelve el primer match + su etapa actual, o null si no existe.
 */
export async function findPostventaContactByPhone(
  organizationId: UUID,
  phoneE164: string,
): Promise<PostventaContactMatch | null> {
  const res = await whaapyPostventaRest<WhaapySearchResponse>(
    organizationId,
    "POST",
    "/contacts/v1/search",
    { filters: { phone_number: { eq: phoneE164 } }, limit: 1 },
  );
  const first = res?.contacts?.[0];
  if (!first?.id) return null;
  return {
    contactId: first.id,
    currentStageId: first.funnel_stage?.id ?? null,
  };
}

// ============================================================
// Contacto: crear (cuando no existe en el Whaapy de Post-venta)
// ============================================================

export interface CreatePostventaContactInput {
  name: string | null;
  phoneE164: string;
  email: string | null;
  customFields: Record<string, string | null>;
}

/**
 * Crea el contacto en el Whaapy de Post-venta (que arranca vacío — la base
 * maestra vive en el Whaapy de Venta). Se crea SIN etapa; el caller mueve
 * después con `movePostventaContactToStage` para GARANTIZAR que dispare la
 * automatización `pipeline_stage_entered` (crear con funnel_stage_id no está
 * confirmado que la dispare).
 *
 * Idempotente: si el teléfono ya existe, Whaapy devuelve 409
 * `duplicate_contact` con `existing_contact_id` → se enlaza en vez de
 * duplicar (cubre la carrera "search miss + create concurrente").
 *
 * Devuelve el contact_id (parseo defensivo: la respuesta viene envuelta en
 * `{contact:{id}}`, con fallback a `{id}` plano — ver lección del wrapper
 * del GET en ERRORES.md).
 */
export async function createPostventaContact(
  organizationId: UUID,
  input: CreatePostventaContactInput,
): Promise<string> {
  const body: Record<string, unknown> = {
    phone_number: input.phoneE164,
    custom_fields: input.customFields,
  };
  if (input.name) body.name = input.name;
  if (input.email) body.email = input.email;

  const result = await whaapyPostventaRestWith409<{
    contact?: { id?: string } | null;
    id?: string;
  }>(organizationId, "POST", "/contacts/v1", body);

  if (result.ok) {
    const id = result.data?.contact?.id ?? result.data?.id;
    if (!id) throw new Error("whaapy_postventa_create_no_id_in_response");
    return id;
  }
  // 409 duplicate_contact → usar el existing_contact_id del body.
  const existing = extractExistingContactId(result.body);
  if (existing) return existing;
  throw new Error("whaapy_postventa_create_conflict_without_existing_id");
}

function extractExistingContactId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const direct = obj.existing_contact_id;
  if (typeof direct === "string" && direct) return direct;
  const err = obj.error;
  if (err && typeof err === "object") {
    const inner = (err as Record<string, unknown>).existing_contact_id;
    if (typeof inner === "string" && inner) return inner;
  }
  return null;
}

// ============================================================
// Contacto: escribir custom_fields (contexto del pedido)
// ============================================================

/**
 * PATCH de custom_fields del contacto en el Whaapy de Post-venta. Whaapy
 * FUSIONA los custom_fields (no reemplaza), así que solo mandamos las
 * claves centrhub_*. Esto graba el opportunity_id (match inverso del
 * webhook 3) y el ref del pedido (usable en el template del mensaje).
 */
export async function patchPostventaContactCustomFields(
  organizationId: UUID,
  contactId: string,
  customFields: Record<string, string | null>,
): Promise<void> {
  await whaapyPostventaRest<unknown>(
    organizationId,
    "PATCH",
    `/contacts/v1/${contactId}`,
    { custom_fields: customFields },
  );
}

// ============================================================
// Contacto: mover de etapa (dispara la automatización interna de Whaapy)
// ============================================================

// ============================================================
// Contacto: leer custom_fields (match inverso del webhook 3)
// ============================================================

interface WhaapyContactGetResponse {
  // GET /contacts/v1/{id} envuelve en `{ contact: {...} }` (ERRORES.md
  // "GET /contacts/v1/{id} de Whaapy envuelve en {contact:{...}}").
  contact?: { custom_fields?: Record<string, unknown> | null } | null;
  // Defensa por si una variante devuelve el shape plano.
  custom_fields?: Record<string, unknown> | null;
}

/**
 * Lee los `custom_fields` del contacto en el Whaapy de Post-venta. Lo usa
 * el webhook 3 para recuperar `centrhub_opportunity_id` (match inverso sin
 * ambigüedad cuando el contacto tiene varias órdenes). Devuelve `{}` si el
 * contacto no tiene custom_fields.
 */
export async function getPostventaContactCustomFields(
  organizationId: UUID,
  contactId: string,
): Promise<Record<string, unknown>> {
  const res = await whaapyPostventaRest<WhaapyContactGetResponse>(
    organizationId,
    "GET",
    `/contacts/v1/${contactId}`,
  );
  return res?.contact?.custom_fields ?? res?.custom_fields ?? {};
}

/**
 * Mueve el contacto a la etapa destino. Este move dispara dentro de Whaapy
 * la automatización `pipeline_stage_entered` (mensaje + asignación) que
 * configura el operador. Idempotente del lado plataforma: el caller salta
 * el move si el contacto ya está en la etapa destino.
 */
export async function movePostventaContactToStage(
  organizationId: UUID,
  contactId: string,
  stageId: string,
): Promise<void> {
  await whaapyPostventaRest<unknown>(
    organizationId,
    "POST",
    `/funnel/v1/contacts/${contactId}/move`,
    { stage_id: stageId },
  );
}
