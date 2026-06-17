/* eslint-disable no-console */
/**
 * Correctivo — limpia las direcciones DUPLICADAS que el bug de
 * propagación generó en Shopify entre el 2026-06-09 (commit 1b644de
 * "Fix pipeline P2", que cableó la propagación de dirección) y el deploy
 * del fix.
 *
 * Contexto del bug (ver ERRORES.md "Edición de dirección desde la
 * plataforma duplicaba la dirección en Shopify"): el worker mandaba la
 * dirección en el array `addresses[]` del PUT de customer SIN el
 * `address_id`. Shopify lo trataba como ALTA → la dirección vieja
 * quedaba como predeterminada y el cambio se apendaba como una dirección
 * adicional suelta. Resultado: customers con DOS (o más) direcciones, la
 * default desactualizada y la editada colgando.
 *
 * Qué hace (CONSERVADOR):
 *   - Candidatos: contactos con `shopify_customer_id` que tuvieron una
 *     edición de dirección desde la plataforma (audit
 *     `contact_edited_manually` con `address` en `fields`) DESDE el corte.
 *     Este es el universo EXACTO del bug — solo una edición de dirección
 *     desde la plataforma pudo generar el duplicado. Es el modo que se
 *     corre EN VIVO.
 *   - `--full-sweep` recorre TODOS los contactos enlazados como red de
 *     diagnóstico, pero es SOLO-REPORTE (nunca escribe, ni sin
 *     --dry-run): sobre-matchea (un customer con una dirección no-default
 *     que casualmente iguala al maestro NO es un duplicado del bug, puede
 *     ser una dirección legítima agregada en Shopify). Sirve para
 *     inspección manual, no para borrado automático.
 *   - Por candidato: GET de las direcciones del customer en Shopify.
 *   - SOLO actúa si hay >1 dirección Y al menos una NO-default coincide
 *     (en sus campos núcleo: address1/address2/city/zip) con la dirección
 *     ACTUAL del maestro → esa es la apéndice del bug. Plan:
 *       (a) si la default está desactualizada, la ACTUALIZA EN SITIO al
 *           valor del maestro (reusa el mismo contrato que el fix vivo),
 *       (b) BORRA las no-default que coinciden con el maestro (el
 *           duplicado del bug).
 *   - Direcciones no-default que NO coinciden con el maestro NO se tocan
 *     (podrían ser direcciones legítimas agregadas por staff en Shopify)
 *     — se REPORTAN como "ambiguas, revisar manual".
 *
 * NUNCA borra la dirección predeterminada. NUNCA toca tags, asesor, ni
 * órdenes. El maestro (plataforma) es la fuente de verdad; Shopify se
 * corrige hacia él.
 *
 * Idempotente: re-correr no encuentra duplicados (ya borrados) → no-op.
 *
 * Uso:
 *   # Dry-run (no escribe — lista qué tocaría):
 *   npm run maintenance:dedupe-shopify-contact-addresses -- --org-slug centr --dry-run
 *
 *   # Barrido completo en dry-run (todos los contactos enlazados):
 *   npm run maintenance:dedupe-shopify-contact-addresses -- --org-slug centr --dry-run --full-sweep
 *
 *   # Vivo (tras validar el dry-run):
 *   npm run maintenance:dedupe-shopify-contact-addresses -- --org-slug centr
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import { shopifyRest } from "@/lib/shopify/admin-client";
import { markOutboundWrite } from "@/lib/services/sync-loop-defense";
import { recordAuditEvent } from "@/lib/db/operational";
import { PLATFORM_ORIGIN_MARKER } from "@/lib/constants";
import {
  parseStoredAddress,
  structuredAddressToShopify,
} from "@/lib/contacts/address";
import type { ContactRow, UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

/** Corte: día en que se cableó la propagación de dirección (commit 1b644de). */
const BUG_INTRODUCED_AT = "2026-06-09T00:00:00.000Z";

/** Throttle entre customers — Shopify REST tolera ~2 req/s por tienda. */
const THROTTLE_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * GET/PUT/DELETE con reintento ante 429 (rate limit de Shopify). El
 * cliente base no reintenta 429 (lo deja a Inngest en los workers); en
 * un script de barrido lo manejamos acá con backoff.
 */
async function restWithRetry<T>(
  fn: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  let backoff = 1000;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 429 && i < attempts - 1) {
        await sleep(backoff);
        backoff *= 2;
        continue;
      }
      throw e;
    }
  }
  throw new Error("restWithRetry: agotados los reintentos");
}

interface Args {
  orgSlug: string;
  dryRun: boolean;
  fullSweep: boolean;
}

function parseArgs(): Args {
  let orgSlug: string | null = null;
  let dryRun = false;
  let fullSweep = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--full-sweep") fullSweep = true;
  }
  if (!orgSlug) {
    console.error(
      "Uso: tsx dedupe-shopify-contact-addresses.ts --org-slug <slug> [--dry-run] [--full-sweep]",
    );
    process.exit(2);
  }
  return { orgSlug, dryRun, fullSweep };
}

interface ShopifyAddr {
  id: number | string;
  default?: boolean;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  zip?: string | null;
  [k: string]: unknown;
}

function norm(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

/**
 * Clave núcleo para comparar "misma dirección" sin que el mapeo de
 * país/estado a código (country_code vs country) introduzca ruido:
 * compara solo address1/address2/city/zip, que NO se transforman.
 */
function coreKey(a: {
  address1?: unknown;
  address2?: unknown;
  city?: unknown;
  zip?: unknown;
}): string {
  return [norm(a.address1), norm(a.address2), norm(a.city), norm(a.zip)].join("|");
}

/** Candidatos: contactos enlazados con edición de dirección desde el corte. */
async function listCandidatesByAudit(): Promise<ContactRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data: audits, error: auditErr } = await supabase
    .from("audit_log")
    .select("entity_id, payload")
    .eq("organization_id", organizationId)
    .eq("event_type", "contact_edited_manually")
    .eq("entity_type", "contact")
    .gte("created_at", BUG_INTRODUCED_AT);
  if (auditErr) throw auditErr;

  const ids = new Set<string>();
  for (const row of audits ?? []) {
    const fields = (row.payload as { fields?: unknown })?.fields;
    if (Array.isArray(fields) && fields.includes("address") && row.entity_id) {
      ids.add(row.entity_id as string);
    }
  }
  if (ids.size === 0) return [];

  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", organizationId)
    .in("id", Array.from(ids))
    .not("shopify_customer_id", "is", null);
  if (error) throw error;
  return (data ?? []) as ContactRow[];
}

/** Red: TODOS los contactos enlazados a Shopify. */
async function listAllShopifyLinked(): Promise<ContactRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", organizationId)
    .not("shopify_customer_id", "is", null);
  if (error) throw error;
  return (data ?? []) as ContactRow[];
}

interface OutboundCtx {
  organizationId: UUID;
  shopDomain: string;
}

async function fetchAddresses(
  ctx: OutboundCtx,
  shopifyCustomerId: string,
): Promise<{ defaultId: string | null; addresses: ShopifyAddr[] }> {
  const res = await restWithRetry(() =>
    shopifyRest<{
      customer?: {
        default_address?: ShopifyAddr | null;
        addresses?: ShopifyAddr[] | null;
      };
    }>(ctx, "GET", `/customers/${shopifyCustomerId}.json`),
  );
  const customer = res.customer;
  const addresses = customer?.addresses ?? [];
  const defaultId = customer?.default_address?.id
    ? String(customer.default_address.id)
    : addresses.find((a) => a.default)?.id
      ? String(addresses.find((a) => a.default)!.id)
      : null;
  return { defaultId, addresses };
}

async function main(): Promise<void> {
  const args = parseArgs();
  void getSupabaseAdminClient();

  const org = await getOrganizationBySlug(args.orgSlug);
  if (!org) {
    console.error(`org ${args.orgSlug} no encontrada`);
    process.exit(1);
  }
  const shopDomain = org.shopify_store_domain;
  if (!shopDomain) {
    console.error(`org ${args.orgSlug} sin shopify_store_domain — nada que hacer.`);
    process.exit(1);
  }

  console.log(
    `Correctivo de duplicados de dirección en Shopify · "${org.name}" ` +
      `(dry-run=${args.dryRun}, full-sweep=${args.fullSweep}, corte=${BUG_INTRODUCED_AT}).\n`,
  );

  // full-sweep es SOLO diagnóstico: sobre-matchea direcciones legítimas,
  // así que nunca escribe aunque no se pase --dry-run.
  const reportOnly = args.dryRun || args.fullSweep;
  if (args.fullSweep && !args.dryRun) {
    console.log(
      "⚠️  --full-sweep es SOLO-REPORTE (no escribe): sobre-matchea " +
        "direcciones legítimas. Para corregir en vivo, usar el modo por " +
        "audit (sin --full-sweep).\n",
    );
  }

  await withTenantContext(
    org.id as UUID,
    async () => {
      const ctx: OutboundCtx = { organizationId: org.id as UUID, shopDomain };
      const candidates = args.fullSweep
        ? await listAllShopifyLinked()
        : await listCandidatesByAudit();
      console.log(
        `Candidatos (${args.fullSweep ? "barrido completo — diagnóstico" : "por audit de edición de dirección"}): ${candidates.length}\n`,
      );

      let affected = 0;
      let totalDeleted = 0;
      let totalDefaultsUpdated = 0;
      let totalAmbiguous = 0;

      for (let idx = 0; idx < candidates.length; idx++) {
        const c = candidates[idx];
        if (idx > 0) await sleep(THROTTLE_MS); // throttle anti-429
        const customerId = c.shopify_customer_id as string;
        const masterShopify = structuredAddressToShopify(
          parseStoredAddress(c.address),
          c.phone,
        );
        if (!masterShopify) continue; // sin dirección maestra → nada que reconciliar

        let fetched;
        try {
          fetched = await fetchAddresses(ctx, customerId);
        } catch (e) {
          console.log(
            `  ⚠️  ${c.full_name ?? "(sin nombre)"} [${c.id}] customer=${customerId}: ` +
              `GET falló (${(e as Error).message}) — se omite.`,
          );
          continue;
        }
        const { defaultId, addresses } = fetched;
        if (addresses.length <= 1) continue; // sin duplicado

        const masterKey = coreKey(masterShopify);
        const nonDefault = addresses.filter((a) => String(a.id) !== defaultId);
        const dupes = nonDefault.filter((a) => coreKey(a) === masterKey);
        const ambiguous = nonDefault.filter((a) => coreKey(a) !== masterKey);

        if (dupes.length === 0) {
          // >1 dirección pero ninguna coincide con el maestro → no es el
          // patrón del bug (o ya se limpió). No se toca.
          if (ambiguous.length > 0) {
            totalAmbiguous += ambiguous.length;
            console.log(
              `  ❓ ${c.full_name ?? "(sin nombre)"} [${c.id}] customer=${customerId}: ` +
                `${addresses.length} direcciones, ninguna no-default coincide con el maestro ` +
                `— AMBIGUO, sin acción (revisar manual).`,
            );
          }
          continue;
        }

        affected++;
        const defaultAddr = addresses.find((a) => String(a.id) === defaultId) ?? null;
        const defaultStale = defaultAddr ? coreKey(defaultAddr) !== masterKey : true;
        const tag = reportOnly ? "[dry-run]" : "[live]";

        console.log(
          `${tag} ${c.full_name ?? "(sin nombre)"} [${c.id}] customer=${customerId}\n` +
            `        default actual: ${defaultAddr ? `"${defaultAddr.address1 ?? ""}"` : "—"} ` +
            `(id=${defaultId ?? "—"}) ${defaultStale ? "→ ACTUALIZAR al maestro" : "(ya correcta)"}\n` +
            `        maestro: "${masterShopify.address1 ?? ""}"\n` +
            `        duplicados a BORRAR: ${dupes.length} ` +
            `(${dupes.map((d) => `"${d.address1 ?? ""}"#${d.id}`).join(", ")})` +
            (ambiguous.length
              ? `\n        ambiguas sin tocar: ${ambiguous.length} ` +
                `(${ambiguous.map((a) => `"${a.address1 ?? ""}"#${a.id}`).join(", ")})`
              : ""),
        );
        if (ambiguous.length) totalAmbiguous += ambiguous.length;

        if (!reportOnly) {
          // R11: marca outbound ANTES de escribir (eco se descarta en M3).
          await markOutboundWrite({ contactId: c.id, source: PLATFORM_ORIGIN_MARKER });

          // (a) Reconciliar la default al maestro EN SITIO si está desactualizada.
          if (defaultStale && defaultId) {
            await restWithRetry(() =>
              shopifyRest(
                ctx,
                "PUT",
                `/customers/${customerId}/addresses/${defaultId}.json`,
                { address: { id: Number(defaultId), ...masterShopify } },
              ),
            );
            totalDefaultsUpdated++;
          }
          // (b) Borrar duplicados (no-default que coinciden con el maestro).
          for (const d of dupes) {
            await restWithRetry(() =>
              shopifyRest(
                ctx,
                "DELETE",
                `/customers/${customerId}/addresses/${d.id}.json`,
              ),
            );
            totalDeleted++;
          }
          await recordAuditEvent({
            actorUserId: null,
            eventType: "shopify_customer_address_deduped_corrective",
            entityType: "contact",
            entityId: c.id,
            payload: {
              shopify_customer_id: customerId,
              default_address_id: defaultId,
              default_updated: defaultStale,
              deleted_address_ids: dupes.map((d) => String(d.id)),
              left_ambiguous_ids: ambiguous.map((a) => String(a.id)),
            },
          });
        } else {
          totalDeleted += dupes.length;
          if (defaultStale) totalDefaultsUpdated++;
        }
      }

      console.log("\n=== Reporte ===");
      console.log(`  candidatos revisados:               ${candidates.length}`);
      console.log(`  contactos afectados (con duplicado): ${affected}`);
      console.log(`  defaults ${reportOnly ? "a actualizar" : "actualizadas"}:            ${totalDefaultsUpdated}`);
      console.log(`  duplicados ${reportOnly ? "a borrar" : "borrados"}:               ${totalDeleted}`);
      console.log(`  direcciones ambiguas (sin tocar):    ${totalAmbiguous}`);
      if (reportOnly && !args.fullSweep) {
        console.log("\n  (re-correr SIN --dry-run para aplicar)");
      }
    },
    { source: "script" },
  );
}

main().catch((err: Error) => {
  console.error("dedupe-shopify-contact-addresses falló:", err.message);
  process.exit(1);
});
