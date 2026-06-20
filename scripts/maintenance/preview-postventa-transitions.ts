/* eslint-disable no-console */
/**
 * PREVIEW (dry-run, SOLO LECTURA) del motor de transiciones de Post-venta
 * (M3v2). Lista qué oportunidades de Post-venta MOVERÍA la primera corrida
 * del cron `postventa-transition-engine-hourly` y a qué etapa — SIN mover
 * nada.
 *
 * Para qué: la primera corrida real mueve TODAS las opps históricas a la
 * vez sobre datos de producción. Este preview permite revisar que el mapeo
 * (pago/preparación → etapa, cancel/reembolso → Caso problemático) produce
 * el resultado correcto ANTES de ejecutar — misma disciplina que los
 * correctivos de Shopify con --dry-run.
 *
 * Garantía anti-deriva: usa EXACTAMENTE la misma función de decisión que
 * el run real (`decidePostventaStageMove`), así "lo que mostraría" es
 * bit-a-bit lo que el cron ejecutaría. NO escribe a BD, NO mueve etapas.
 *
 * Uso:
 *   npm run maintenance:preview-postventa-transitions -- --org-slug centr
 *   npm run maintenance:preview-postventa-transitions -- --org-slug centr --only-moves
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getOpportunityById, listActivePostventaOppIds } from "@/lib/db/opportunities";
import { findOrderByShopifyOrderId } from "@/lib/db/orders";
import { listPipelineStages } from "@/lib/db/pipeline";
import {
  decidePostventaStageMove,
  resolvePostventaEngineStages,
  isOrgBackfillInProgress,
} from "@/lib/services/postventa-transition";
import type { PipelineStageRow, UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function parseArgs() {
  let orgSlug: string | null = null;
  let onlyMoves = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--only-moves") onlyMoves = true;
  }
  if (!orgSlug) {
    console.error("Uso: --org-slug <slug> [--only-moves]");
    process.exit(2);
  }
  return { orgSlug, onlyMoves };
}

async function main() {
  const { orgSlug, onlyMoves } = parseArgs();
  void getSupabaseAdminClient();
  const org = await getOrganizationBySlug(orgSlug);
  if (!org) {
    console.error(`org ${orgSlug} no encontrada`);
    process.exit(1);
  }

  console.log(
    `\nPREVIEW motor Post-venta (dry-run, solo lectura) en "${org.name}".\n`,
  );

  await withTenantContext(
    org.id as UUID,
    async () => {
      if (await isOrgBackfillInProgress()) {
        console.log(
          "⚠ backfill_in_progress=true → el cron real estaría en modo pasivo (no movería nada).\n",
        );
      }

      const stages = await resolvePostventaEngineStages();
      if (!stages) {
        console.error(
          "No se pudo resolver el funnel Post-venta (¿faltan etapas?). Abortando.",
        );
        process.exit(1);
      }

      const allStages = await listPipelineStages("post_venta");
      const stageName = new Map<UUID, string>(
        allStages.map((s: PipelineStageRow) => [s.id, s.name]),
      );
      const nameOf = (id: UUID | null | undefined) =>
        id ? stageName.get(id) ?? id : "(?)";

      const oppIds = await listActivePostventaOppIds();
      console.log(`Opps de Post-venta activas evaluadas: ${oppIds.length}\n`);

      const counters: Record<string, number> = {};
      const bump = (k: string) => (counters[k] = (counters[k] ?? 0) + 1);
      const moveRows: string[] = [];
      const otherRows: string[] = [];

      for (const oppId of oppIds) {
        const opp = await getOpportunityById(oppId);
        if (!opp) {
          bump("skip:opportunity_not_found");
          continue;
        }
        const ref = opp.display_reference ?? opp.shopify_order_id ?? opp.id;

        if (!opp.shopify_order_id) {
          bump("skip:no_shopify_order_id");
          otherRows.push(`  · ${ref} :: ${nameOf(opp.stage_id)} → SKIP (no_shopify_order_id)`);
          continue;
        }
        const order = await findOrderByShopifyOrderId(opp.shopify_order_id);
        if (!order) {
          bump("skip:order_not_found");
          otherRows.push(`  · ${ref} :: ${nameOf(opp.stage_id)} → SKIP (order_not_found)`);
          continue;
        }

        const decision = decidePostventaStageMove(opp, order, stages);
        const status = `fin=${order.financial_status} ful=${order.fulfillment_status ?? "∅"}${order.cancelled_at ? " CANCELLED" : ""}`;

        if (decision.kind === "move") {
          bump(`move:${decision.reason}`);
          moveRows.push(
            `  → ${ref} :: ${nameOf(opp.stage_id)} ⇒ ${decision.toStage.name}  [${status}] (${decision.reason})`,
          );
        } else {
          bump(`noop:${decision.reason}`);
          otherRows.push(
            `  · ${ref} :: ${nameOf(opp.stage_id)} → NOOP (${decision.reason})  [${status}]`,
          );
        }
      }

      console.log(`MOVIMIENTOS que ejecutaría la primera corrida (${moveRows.length}):`);
      console.log(moveRows.length ? moveRows.join("\n") : "  (ninguno)");

      if (!onlyMoves) {
        console.log(`\nSin cambio / skips (${otherRows.length}):`);
        console.log(otherRows.length ? otherRows.join("\n") : "  (ninguno)");
      }

      console.log("\nResumen por categoría:");
      for (const k of Object.keys(counters).sort()) {
        console.log(`  ${k}: ${counters[k]}`);
      }
      console.log(
        "\n(SOLO LECTURA — nada se movió. Para ejecutar, deja correr el cron horario\n" +
          " `postventa-transition-engine-hourly` o invócalo desde el dashboard de Inngest.)\n",
      );
    },
    { source: "script" },
  );
}

main().catch((err: Error) => {
  console.error("preview-postventa-transitions falló:", err.message);
  process.exit(1);
});
