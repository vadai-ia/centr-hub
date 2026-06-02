/* eslint-disable no-console */
/**
 * Rehidratación correctiva one-shot — contactos Shopify nacidos
 * vacíos antes del fix preventivo (ver entrada en ERRORES.md
 * "Contactos Shopify creados vacíos desde webhooks de
 * orders/draft_orders").
 *
 * Identifica los contactos con `shopify_customer_id IS NOT NULL`
 * a los que les falte CUALQUIERA de `full_name`, `email` o `phone`
 * y los enriquece con los datos reales del customer obtenidos via
 * `GET /admin/api/.../customers/{id}.json`. Reusa el helper
 * `hydrateContactFromEmbeddedShopifyCustomer` (mismo que orders.ts
 * y draft-orders.ts del fix preventivo) para aplicar LWW por campo
 * y respetar valores más recientes ya presentes.
 *
 * Garantías:
 *   - Idempotente: una vez que el contact tiene los tres campos
 *     poblados, el filtro deja de seleccionarlo. Correr dos veces
 *     seguidas no duplica ni corrompe nada. Para contactos
 *     parcialmente completos (ej. nombre OK pero sin teléfono) el
 *     helper aplica LWW por campo: datos buenos existentes NO se
 *     pisan; campos vacíos se llenan si Shopify trae el dato.
 *   - LWW respetado: el helper reconcilia por campo via
 *     `reconcileContactFields`. Valores más recientes (ej. nombre
 *     editado en Whaapy después de que el stub se creó) no se
 *     pisan.
 *   - SIN efectos secundarios encadenados: el helper NO ejecuta
 *     `recordWhaapySyncIntent` (creación a Whaapy) ni
 *     `applyAssignmentFromTags`. R12 (auto-creación de oportunidad
 *     C2) vive en M4 outbound de Whaapy, no en este path. El flag
 *     `backfill_in_progress = true` se setea como defensa extra
 *     durante toda la corrida — incluso si algo invocara outbound,
 *     queda suprimido.
 *   - Customer 404: se loguea + cuenta como
 *     `customer_not_found_in_shopify` y la corrida sigue.
 *   - Customer genuinamente vacío (Shopify devuelve nombre/email/
 *     phone todos null): se cuenta como `genuinely_empty_in_shopify`,
 *     NO se actualiza el contact local (no hay nada que aplicar).
 *   - Cortesía contra rate limit: 150ms de espera entre llamadas.
 *
 * Uso:
 *   # Dry-run sobre TODOS los stubs (no toca BD, solo lista):
 *   npm run shopify:rehydrate-empty-contacts -- --org-slug centr --dry-run
 *
 *   # Prueba sobre los primeros 3 (recomendado antes de correr todo):
 *   npm run shopify:rehydrate-empty-contacts -- --org-slug centr --limit 3
 *
 *   # Corrida completa:
 *   npm run shopify:rehydrate-empty-contacts -- --org-slug centr
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  getOrganizationBySlug,
  updateOrganization,
} from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import { shopifyRest, ShopifyApiError } from "@/lib/shopify/admin-client";
import { mapCustomerWebhookToNormalized } from "@/lib/shopify/mappers";
import { hydrateContactFromEmbeddedShopifyCustomer } from "@/lib/inngest/functions/customers";
import { recordAuditEvent } from "@/lib/db/operational";
import type { ContactRow, Json, UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

interface Args {
  orgSlug: string;
  limit: number | null;
  dryRun: boolean;
}

function parseArgs(): Args {
  let orgSlug: string | null = null;
  let limit: number | null = null;
  let dryRun = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--limit") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) limit = n;
    } else if (argv[i] === "--dry-run") dryRun = true;
  }
  if (!orgSlug) {
    console.error(
      "Uso: tsx rehydrate-empty-contacts.ts --org-slug <slug> [--limit N] [--dry-run]",
    );
    process.exit(2);
  }
  return { orgSlug, limit, dryRun };
}

/**
 * Filtro: contactos con `shopify_customer_id` poblado a los que les
 * falte CUALQUIERA de `full_name`, `email` o `phone`. Cubre tanto
 * los stubs originales (los tres en NULL) como los contactos que
 * quedaron parcialmente completos por bugs intermedios (ej. nombre
 * y email ok, pero teléfono NULL por el bug previo que ignoraba
 * `default_address.phone` — ver ERRORES.md). Excluimos
 * `deleted_in_shopify` y `anonymized_at` porque no queremos
 * resucitar registros marcados para borrado. La lógica de
 * hidratación (LWW por campo, idempotencia) no se toca — el helper
 * decide qué fields aplicar y cuáles ignorar como `older_ignored`.
 */
async function listEmptyShopifyContacts(
  limit: number | null,
): Promise<ContactRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", organizationId)
    .not("shopify_customer_id", "is", null)
    .or("full_name.is.null,email.is.null,phone.is.null")
    .is("anonymized_at", null)
    .eq("deleted_in_shopify", false)
    .order("created_at", { ascending: true });
  if (limit && limit > 0) query = query.limit(limit);
  const { data, error } = await query;
  if (error) throw error;
  return (data as ContactRow[]) ?? [];
}

interface ProcessOutcome {
  contactId: UUID;
  shopifyCustomerId: string;
  status:
    | "enriched"
    | "genuinely_empty_in_shopify"
    | "customer_not_found_in_shopify"
    | "fetch_failed"
    | "dry_run_would_enrich";
  detail?: string;
}

async function processOne(
  contact: ContactRow,
  ctx: { organizationId: UUID; shopDomain: string },
  dryRun: boolean,
): Promise<ProcessOutcome> {
  const shopifyCustomerId = contact.shopify_customer_id;
  if (!shopifyCustomerId) {
    // El filtro nunca debería traer uno sin id; defensivo.
    return {
      contactId: contact.id,
      shopifyCustomerId: "",
      status: "fetch_failed",
      detail: "contact_sin_shopify_customer_id",
    };
  }

  if (dryRun) {
    return {
      contactId: contact.id,
      shopifyCustomerId,
      status: "dry_run_would_enrich",
    };
  }

  let raw: { customer: unknown };
  try {
    raw = await shopifyRest<{ customer: unknown }>(
      ctx,
      "GET",
      `/customers/${shopifyCustomerId}.json`,
    );
  } catch (err) {
    if (err instanceof ShopifyApiError && err.status === 404) {
      await recordAuditEvent({
        actorUserId: null,
        eventType: "contact_rehydration_customer_not_found",
        entityType: "contact",
        entityId: contact.id,
        payload: { shopify_customer_id: shopifyCustomerId } as Json,
      });
      return {
        contactId: contact.id,
        shopifyCustomerId,
        status: "customer_not_found_in_shopify",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    await recordAuditEvent({
      actorUserId: null,
      eventType: "contact_rehydration_fetch_failed",
      entityType: "contact",
      entityId: contact.id,
      payload: {
        shopify_customer_id: shopifyCustomerId,
        error: message,
      } as Json,
    });
    return {
      contactId: contact.id,
      shopifyCustomerId,
      status: "fetch_failed",
      detail: message,
    };
  }

  let normalized;
  try {
    normalized = mapCustomerWebhookToNormalized(raw.customer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordAuditEvent({
      actorUserId: null,
      eventType: "contact_rehydration_parse_failed",
      entityType: "contact",
      entityId: contact.id,
      payload: {
        shopify_customer_id: shopifyCustomerId,
        error: message,
      } as Json,
    });
    return {
      contactId: contact.id,
      shopifyCustomerId,
      status: "fetch_failed",
      detail: `parse_failed: ${message}`,
    };
  }

  // Si Shopify devuelve el customer pero con nombre/email/phone TODOS
  // null, no hay nada útil que aplicar. Lo registramos para que el
  // operador sepa que NO es bug del script — el customer en Shopify
  // realmente está incompleto.
  if (
    normalized.fullName === null &&
    normalized.email === null &&
    normalized.phone === null
  ) {
    await recordAuditEvent({
      actorUserId: null,
      eventType: "contact_rehydration_genuinely_empty",
      entityType: "contact",
      entityId: contact.id,
      payload: { shopify_customer_id: shopifyCustomerId } as Json,
    });
    return {
      contactId: contact.id,
      shopifyCustomerId,
      status: "genuinely_empty_in_shopify",
    };
  }

  const customerUpdatedAt =
    normalized.updatedAt ?? normalized.createdAt ?? new Date().toISOString();
  await hydrateContactFromEmbeddedShopifyCustomer(normalized, customerUpdatedAt);
  await recordAuditEvent({
    actorUserId: null,
    eventType: "contact_rehydrated_from_shopify",
    entityType: "contact",
    entityId: contact.id,
    payload: {
      shopify_customer_id: shopifyCustomerId,
      customer_updated_at: customerUpdatedAt,
      had_name: normalized.fullName !== null,
      had_email: normalized.email !== null,
      had_phone: normalized.phone !== null,
    } as Json,
  });
  return {
    contactId: contact.id,
    shopifyCustomerId,
    status: "enriched",
  };
}

async function main() {
  const args = parseArgs();
  void getSupabaseAdminClient();
  const org = await getOrganizationBySlug(args.orgSlug);
  if (!org) {
    console.error(`org ${args.orgSlug} no encontrada`);
    process.exit(1);
  }
  if (!org.shopify_store_domain) {
    console.error(`org ${args.orgSlug} no tiene shopify_store_domain`);
    process.exit(1);
  }
  const ctx = {
    organizationId: org.id as UUID,
    shopDomain: org.shopify_store_domain,
  };

  console.log(
    `Rehidratación correctiva para "${org.name}" ` +
      `(limit=${args.limit ?? "ALL"}, dry-run=${args.dryRun}).`,
  );

  // Activar flag aunque sea dry-run — defensa extra contra outbound
  // en caso de que algo se gatille por error durante el dry-run.
  if (!args.dryRun) {
    await updateOrganization(org.id, {
      backfill_in_progress: true,
    } as unknown as Partial<typeof org>);
  }

  const outcomes: ProcessOutcome[] = [];

  try {
    await withTenantContext(
      ctx.organizationId,
      async () => {
        const candidates = await listEmptyShopifyContacts(args.limit);
        console.log(
          `Encontrados ${candidates.length} contactos con ` +
            `shopify_customer_id a los que les falta nombre, email o teléfono.`,
        );

        if (candidates.length === 0) {
          console.log("Nada que hidratar. Salida limpia.");
          return;
        }

        if (!args.dryRun) {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "contact_rehydration_started",
            entityType: null,
            entityId: null,
            payload: {
              candidates: candidates.length,
              shop_domain: ctx.shopDomain,
              limit_arg: args.limit,
            } as Json,
          });
        }

        for (let i = 0; i < candidates.length; i++) {
          const contact = candidates[i];
          const outcome = await processOne(contact, ctx, args.dryRun);
          outcomes.push(outcome);

          const tag = args.dryRun ? "[dry-run]" : "[live]";
          console.log(
            `${tag} ${i + 1}/${candidates.length} contact=${contact.id} ` +
              `shopify_customer_id=${outcome.shopifyCustomerId} ` +
              `→ ${outcome.status}` +
              (outcome.detail ? ` (${outcome.detail})` : ""),
          );

          // Cortesía contra rate limit (40 req/s en Shopify Admin REST).
          // En dry-run no hay HTTP, salteamos el delay.
          if (!args.dryRun && i + 1 < candidates.length) {
            await new Promise((r) => setTimeout(r, 150));
          }
        }

        if (!args.dryRun) {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "contact_rehydration_finished",
            entityType: null,
            entityId: null,
            payload: summarize(outcomes) as Json,
          });
        }
      },
      { source: "script" },
    );
  } finally {
    if (!args.dryRun) {
      await updateOrganization(org.id, {
        backfill_in_progress: false,
      } as unknown as Partial<typeof org>);
      console.log("backfill_in_progress restaurado a false.");
    }
  }

  printReport(outcomes, args.dryRun);
}

function summarize(outcomes: ProcessOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {
    total_processed: outcomes.length,
    enriched: 0,
    genuinely_empty_in_shopify: 0,
    customer_not_found_in_shopify: 0,
    fetch_failed: 0,
    dry_run_would_enrich: 0,
  };
  for (const o of outcomes) {
    counts[o.status] = (counts[o.status] ?? 0) + 1;
  }
  return counts;
}

function printReport(outcomes: ProcessOutcome[], dryRun: boolean): void {
  const c = summarize(outcomes);
  console.log("\n=== Reporte ===");
  console.log(`  total_processed:               ${c.total_processed}`);
  if (dryRun) {
    console.log(`  dry_run_would_enrich:          ${c.dry_run_would_enrich}`);
    console.log(
      "  (re-correr SIN --dry-run para aplicar los cambios)",
    );
    return;
  }
  console.log(`  enriched:                      ${c.enriched}`);
  console.log(`  genuinely_empty_in_shopify:    ${c.genuinely_empty_in_shopify}`);
  console.log(`  customer_not_found_in_shopify: ${c.customer_not_found_in_shopify}`);
  console.log(`  fetch_failed:                  ${c.fetch_failed}`);
  if (c.fetch_failed > 0) {
    console.log("\n  Failures detail:");
    for (const o of outcomes) {
      if (o.status === "fetch_failed") {
        console.log(
          `    - contact=${o.contactId} shopify_customer_id=${o.shopifyCustomerId} → ${o.detail ?? "(sin detalle)"}`,
        );
      }
    }
  }
}

main().catch((err: Error) => {
  console.error("rehydrate-empty-contacts falló:", err.message);
  process.exit(1);
});
