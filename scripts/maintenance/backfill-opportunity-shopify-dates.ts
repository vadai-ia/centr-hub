/* eslint-disable no-console */
/**
 * Correctivo one-shot — rellena las fechas reales de Shopify en
 * `opportunities` y `opportunity_stage_history` (migración 0025),
 * ampliando el fix 0024 de orders a las entidades restantes que el
 * dashboard reporta por periodo.
 *
 * Por qué existe (ver ERRORES.md "KPIs de opps/historial fechados por
 * la fecha de importación..."): el dashboard contaba Cotizaciones,
 * Ganadas, Win/Loss, Sales cycle, Leads, Calificados y Win-rate-por-
 * etapa por la fecha en que el registro entró a la BD (created_at /
 * won_at=now() / changed_at=now()), no por la fecha real del hecho en
 * Shopify. Una carga del 4-8 jun metió ~11 opps que son borradores
 * viejos (#D bajos, feb-abr) y varias "ganadas al instante".
 *
 * Reusa EXACTAMENTE el mecanismo del sync:
 *   - Parte A (fecha de Cotización): GET REST del Draft Order +
 *     `mapDraftOrderWebhookToNormalized` (el mismo mapper de los workers
 *     y del backfill). Escribe `opportunities.shopify_created_at` y la
 *     `shopify_event_at` de la entrada de historial "Cotización"
 *     (context 'webhook').
 *   - Parte B (fecha de Ganada): NO llama a Shopify — toma la fecha real
 *     del PEDIDO local (`orders.shopify_created_at`, ya corregido por el
 *     correctivo 0024) y re-fecha `opportunities.won_at` + la
 *     `shopify_event_at` de la entrada de historial "Ganada"
 *     (context 'trigger_f1_f2'). Las ganadas manuales (context 'manual',
 *     sin pedido) NO se tocan: su fecha es la acción real de plataforma.
 *
 * PRINCIPIO: registro de Shopify → fecha real de Shopify; registro
 * nacido en plataforma (lead R12, win/avance manual) → conserva su
 * fecha propia. Las entradas de historial de origen humano NO se tocan.
 *
 * Garantías:
 *   - Idempotente: Parte A solo procesa opps con `shopify_created_at
 *     IS NULL`; Parte B solo re-fecha si `won_at` difiere de la fecha
 *     del pedido; `setStageHistoryShopifyEventAt` solo toca filas con
 *     `shopify_event_at IS NULL`. Re-correr no reprocesa ni corrompe.
 *   - Dry-run primero (`--dry-run`): hace los GET a Shopify (read-only)
 *     y reporta el plan completo, sin escribir a la BD.
 *   - Audit log por opp efectivamente re-fechada (solo en modo live).
 *
 * Prerrequisito: correr ANTES el correctivo de orders 0024
 * (`maintenance:backfill-order-shopify-created-at`) para que la Parte B
 * tenga `orders.shopify_created_at` poblado de dónde leer.
 *
 * Uso:
 *   # Dry-run (no escribe; reporta plan):
 *   npm run maintenance:backfill-opportunity-shopify-dates -- --org-slug centr --dry-run
 *
 *   # Corrida en vivo (SOLO tras validar el dry-run con el operador):
 *   npm run maintenance:backfill-opportunity-shopify-dates -- --org-slug centr
 *
 *   # Tope defensivo y throttle de Shopify (req/seg):
 *   npm run maintenance:backfill-opportunity-shopify-dates -- --org-slug centr --expected-max 500 --delay-ms 250
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { ShopifyApiError, shopifyRest } from "@/lib/shopify/admin-client";
import { mapDraftOrderWebhookToNormalized } from "@/lib/shopify/mappers";
import {
  listVentaOppsMissingShopifyCreatedAt,
  listWonVentaOppsWithOrder,
  setStageHistoryShopifyEventAt,
  updateOpportunity,
  type OppMissingShopifyCreatedAt,
  type WonOppForRedate,
} from "@/lib/db/opportunities";
import { findOrderByShopifyOrderId } from "@/lib/db/orders";
import { recordAuditEvent } from "@/lib/db/operational";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

interface Args {
  orgSlug: string;
  dryRun: boolean;
  expectedMax: number;
  delayMs: number;
}

function parseArgs(): Args {
  let orgSlug: string | null = null;
  let dryRun = false;
  let expectedMax = 2000;
  let delayMs = 250;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--expected-max") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) expectedMax = n;
    } else if (argv[i] === "--delay-ms") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 0) delayMs = n;
    }
  }
  if (!orgSlug) {
    console.error(
      "Uso: tsx backfill-opportunity-shopify-dates.ts --org-slug <slug> [--dry-run] [--expected-max N] [--delay-ms N]",
    );
    process.exit(2);
  }
  return { orgSlug, dryRun, expectedMax, delayMs };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((res) => setTimeout(res, ms));
}

// ------------------------------------------------------------
// Parte A — fecha real de creación de la Cotización (Draft Order)
// ------------------------------------------------------------
interface ResolvedDraftRow {
  opp: OppMissingShopifyCreatedAt;
  /** created_at del Draft Order en Shopify, o null si no se resolvió. */
  draftCreatedAt: string | null;
  notFoundInShopify: boolean;
  errored: boolean;
}

async function resolveDraftCreatedAt(
  opp: OppMissingShopifyCreatedAt,
  ctx: { organizationId: UUID; shopDomain: string },
): Promise<ResolvedDraftRow> {
  try {
    const res = await shopifyRest<{ draft_order: unknown }>(
      ctx,
      "GET",
      `/draft_orders/${opp.shopify_draft_order_id}.json`,
    );
    const normalized = mapDraftOrderWebhookToNormalized(res.draft_order);
    return {
      opp,
      draftCreatedAt: normalized.createdAt,
      notFoundInShopify: false,
      errored: false,
    };
  } catch (err) {
    if (err instanceof ShopifyApiError && err.status === 404) {
      return { opp, draftCreatedAt: null, notFoundInShopify: true, errored: false };
    }
    console.error(
      `  ! error al consultar draft_order ${opp.shopify_draft_order_id}: ${(err as Error).message}`,
    );
    return { opp, draftCreatedAt: null, notFoundInShopify: false, errored: true };
  }
}

// ------------------------------------------------------------
// Parte B — fecha real de Ganada (del pedido local, sin Shopify)
// ------------------------------------------------------------
interface ResolvedWonRow {
  opp: WonOppForRedate;
  /** shopify_created_at del pedido local, o null si falta. */
  orderShopifyCreatedAt: string | null;
  /** true si won_at ya coincide (nada que re-fechar). */
  alreadyAligned: boolean;
}

async function resolveWonRedate(opp: WonOppForRedate): Promise<ResolvedWonRow> {
  const order = await findOrderByShopifyOrderId(opp.shopify_order_id);
  const orderShopifyCreatedAt = order?.shopify_created_at ?? null;
  const alreadyAligned =
    orderShopifyCreatedAt !== null && orderShopifyCreatedAt === opp.won_at;
  return { opp, orderShopifyCreatedAt, alreadyAligned };
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
    `Correctivo fechas de opps/historial en "${org.name}" (dry-run=${args.dryRun}, delay=${args.delayMs}ms).`,
  );

  await withTenantContext(
    org.id as UUID,
    async () => {
      // ========================================================
      // PARTE A — fecha de creación de la Cotización (Draft Order)
      // ========================================================
      const missingCreated = await listVentaOppsMissingShopifyCreatedAt();
      console.log(`\n[A] Opps de Venta con draft y sin shopify_created_at: ${missingCreated.length}`);

      const resolvedDrafts: ResolvedDraftRow[] = [];
      for (let i = 0; i < missingCreated.length; i++) {
        const r = await resolveDraftCreatedAt(missingCreated[i], ctx);
        resolvedDrafts.push(r);
        if ((i + 1) % 25 === 0) {
          console.log(`  ...verificadas ${i + 1}/${missingCreated.length}`);
        }
        await sleep(args.delayMs);
      }

      const toRefechaA = resolvedDrafts.filter((r) => r.draftCreatedAt !== null);
      const notFoundA = resolvedDrafts.filter((r) => r.notFoundInShopify);
      const erroredA = resolvedDrafts.filter((r) => r.errored);

      console.log("  -- existen en Shopify:   " + toRefechaA.length);
      console.log("  -- NO existen (404):     " + notFoundA.length);
      console.log("  -- error al consultar:   " + erroredA.length);
      console.log("  Plan de refecha (primeras 30):");
      for (const r of toRefechaA.slice(0, 30)) {
        console.log(
          `    - opp=${r.opp.id} draft=${r.opp.shopify_draft_order_id} :: ` +
            `shopify_created_at: NULL → ${r.draftCreatedAt} (BD created_at=${r.opp.created_at})`,
        );
      }
      if (toRefechaA.length > 30) console.log(`    ... y ${toRefechaA.length - 30} más.`);
      if (notFoundA.length > 0) {
        console.log("  Drafts que NO existen en Shopify (se reportan, NO se tocan):");
        for (const r of notFoundA) {
          console.log(`    - opp=${r.opp.id} draft=${r.opp.shopify_draft_order_id}`);
        }
      }

      // ========================================================
      // PARTE B — fecha de Ganada (del pedido local)
      // ========================================================
      const wonCandidates = await listWonVentaOppsWithOrder();
      const resolvedWon: ResolvedWonRow[] = [];
      for (const opp of wonCandidates) {
        resolvedWon.push(await resolveWonRedate(opp));
      }
      const toRefechaB = resolvedWon.filter(
        (r) => r.orderShopifyCreatedAt !== null && !r.alreadyAligned,
      );
      const missingOrderDateB = resolvedWon.filter((r) => r.orderShopifyCreatedAt === null);
      const alignedB = resolvedWon.filter((r) => r.alreadyAligned);

      console.log(`\n[B] Opps de Venta ganadas con pedido ligado: ${wonCandidates.length}`);
      console.log("  -- a re-fechar won_at:   " + toRefechaB.length);
      console.log("  -- ya alineadas:         " + alignedB.length);
      console.log(
        "  -- pedido sin shopify_created_at (correr 0024 primero): " + missingOrderDateB.length,
      );
      console.log("  Plan de refecha de won_at (primeras 30):");
      for (const r of toRefechaB.slice(0, 30)) {
        console.log(
          `    - opp=${r.opp.id} order=${r.opp.shopify_order_id} :: ` +
            `won_at: ${r.opp.won_at} → ${r.orderShopifyCreatedAt}`,
        );
      }
      if (toRefechaB.length > 30) console.log(`    ... y ${toRefechaB.length - 30} más.`);

      // Tope defensivo combinado.
      const totalToWrite = toRefechaA.length + toRefechaB.length;
      if (totalToWrite > args.expectedMax) {
        console.error(
          `\nABORTADO: ${totalToWrite} re-fechas (A=${toRefechaA.length} + B=${toRefechaB.length}) ` +
            `excede el tope defensivo ${args.expectedMax}. Re-correr con --expected-max ` +
            `${totalToWrite} si el volumen es esperado, o investigar antes.`,
        );
        process.exit(3);
      }

      if (args.dryRun) {
        console.log(
          "\n=== Reporte (dry-run) ===\n" +
            `  [A] opps con shopify_created_at a poblar: ${toRefechaA.length}\n` +
            `  [A] drafts inexistentes (no se tocan):    ${notFoundA.length}\n` +
            `  [B] won_at a re-fechar:                   ${toRefechaB.length}\n` +
            `  [B] pedidos sin fecha (correr 0024):      ${missingOrderDateB.length}\n` +
            "  (re-correr SIN --dry-run para aplicar, tras validar el operador)",
        );
        return;
      }

      // ========================================================
      // LIVE — escribir
      // ========================================================
      let fixedA = 0;
      for (const r of toRefechaA) {
        const ts = r.draftCreatedAt as string;
        await updateOpportunity(r.opp.id, { shopify_created_at: ts });
        const touched = await setStageHistoryShopifyEventAt({
          opportunityId: r.opp.id,
          context: "webhook",
          shopifyEventAt: ts,
        });
        await recordAuditEvent({
          actorUserId: null,
          eventType: "opportunity_shopify_created_at_backfilled",
          entityType: "opportunity",
          entityId: r.opp.id,
          payload: {
            shopify_draft_order_id: r.opp.shopify_draft_order_id,
            shopify_created_at: ts,
            db_created_at: r.opp.created_at,
            stage_history_rows_dated: touched,
          },
        });
        fixedA++;
      }

      let fixedB = 0;
      for (const r of toRefechaB) {
        const ts = r.orderShopifyCreatedAt as string;
        await updateOpportunity(r.opp.id, { won_at: ts });
        const touched = await setStageHistoryShopifyEventAt({
          opportunityId: r.opp.id,
          context: "trigger_f1_f2",
          shopifyEventAt: ts,
        });
        await recordAuditEvent({
          actorUserId: null,
          eventType: "opportunity_won_at_redated_from_order",
          entityType: "opportunity",
          entityId: r.opp.id,
          payload: {
            shopify_order_id: r.opp.shopify_order_id,
            won_at_from: r.opp.won_at,
            won_at_to: ts,
            stage_history_rows_dated: touched,
          },
        });
        fixedB++;
      }

      console.log(
        "\n=== Reporte (live) ===\n" +
          `  [A] opps con shopify_created_at poblado: ${fixedA}\n` +
          `  [A] drafts inexistentes (no tocados):    ${notFoundA.length}\n` +
          `  [B] won_at re-fechados:                  ${fixedB}\n` +
          `  [B] pedidos sin fecha (correr 0024):     ${missingOrderDateB.length}`,
      );
    },
    { source: "script" },
  );
}

main().catch((err: Error) => {
  console.error("backfill-opportunity-shopify-dates falló:", err.message);
  process.exit(1);
});
