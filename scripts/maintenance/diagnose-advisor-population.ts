/* eslint-disable no-console */
/**
 * DIAGNÓSTICO READ-ONLY — dimensiona la población afectada por el bug de
 * asesor "sin asignar" (caso Eduardo Badir generalizado). NO escribe nada.
 *
 * Clasifica las opps de Funnel Venta en modos de falla:
 *   MODO A (gated-out): opp con asesor NULL cuyo PEDIDO (por shopify_order_id)
 *           tiene asesor, pero el pedido es HUÉRFANO (opportunity_id NULL),
 *           por lo que el hook 0023 nunca se invocó (gate en orders.ts:290).
 *   MODO B (priority): opp con asesor != asesor del pedido (posible herencia
 *           del contacto que el guardrail "solo NULL" no promueve al del pedido).
 *   Contexto: pedidos huérfanos totales (opportunity_id NULL) que sí matchean
 *           una opp por shopify_order_id — la causa estructural del gate.
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const slug = process.argv.includes("--org-slug")
    ? process.argv[process.argv.indexOf("--org-slug") + 1]
    : "centr";
  void getSupabaseAdminClient();
  const org = await getOrganizationBySlug(slug);
  if (!org) {
    console.error(`org ${slug} no encontrada`);
    process.exit(1);
  }
  await withTenantContext(
    org.id as UUID,
    async () => {
      const { supabase, organizationId } = getTenantScopedClient();

      // Opps de Venta (no canceladas) con shopify_order_id.
      const { data: opps } = await supabase
        .from("opportunities")
        .select("id, assigned_advisor_id, shopify_order_id, stage_id, won_at, display_reference, cancelled_at")
        .eq("organization_id", organizationId)
        .eq("funnel", "venta")
        .is("cancelled_at", null)
        .not("shopify_order_id", "is", null);

      // Orders con asesor, indexadas por shopify_order_id.
      const { data: orders } = await supabase
        .from("orders")
        .select("id, shopify_order_id, assigned_advisor_id, opportunity_id")
        .eq("organization_id", organizationId);
      const orderByShopId = new Map<string, { advisor: string | null; oppId: string | null }>();
      for (const o of (orders ?? []) as Array<Record<string, unknown>>) {
        orderByShopId.set(o.shopify_order_id as string, {
          advisor: (o.assigned_advisor_id as string) ?? null,
          oppId: (o.opportunity_id as string) ?? null,
        });
      }

      const modeA: string[] = []; // opp NULL, order tiene asesor, order huérfano
      const modeA_linked: string[] = []; // opp NULL, order tiene asesor, order YA linkeado (hook debió correr)
      const modeB: string[] = []; // opp asesor != order asesor (ambos no-null)
      const oppNullNoOrderAdvisor: string[] = []; // opp NULL y order sin asesor tampoco

      for (const op of (opps ?? []) as Array<Record<string, unknown>>) {
        const oppAdvisor = (op.assigned_advisor_id as string) ?? null;
        const soid = op.shopify_order_id as string;
        const ord = orderByShopId.get(soid);
        const ref = (op.display_reference as string) ?? op.id;
        if (!ord) continue;
        if (oppAdvisor === null) {
          if (ord.advisor) {
            if (ord.oppId === null) modeA.push(`${ref} (opp=${op.id})`);
            else modeA_linked.push(`${ref} (opp=${op.id})`);
          } else {
            oppNullNoOrderAdvisor.push(`${ref}`);
          }
        } else if (ord.advisor && ord.advisor !== oppAdvisor) {
          modeB.push(`${ref}: opp=${oppAdvisor} order=${ord.advisor}`);
        }
      }

      // Pedidos huérfanos totales que matchean una opp por shopify_order_id.
      const oppShopIds = new Set(
        ((opps ?? []) as Array<{ shopify_order_id: string }>).map((o) => o.shopify_order_id),
      );
      const orphanLinkable = ((orders ?? []) as Array<Record<string, unknown>>).filter(
        (o) => o.opportunity_id === null && oppShopIds.has(o.shopify_order_id as string),
      ).length;
      const orphanTotal = ((orders ?? []) as Array<Record<string, unknown>>).filter(
        (o) => o.opportunity_id === null,
      ).length;

      console.log("=== POBLACIÓN AFECTADA (Funnel Venta, no canceladas) ===\n");
      console.log(`Opps de Venta con shopify_order_id:           ${opps?.length ?? 0}`);
      console.log(`Orders totales:                                ${orders?.length ?? 0}`);
      console.log(`Orders huérfanas (opportunity_id NULL):        ${orphanTotal}`);
      console.log(`  ...de ésas, linkeables a una opp por SOID:   ${orphanLinkable}  <-- causa del gate\n`);
      console.log(`MODO A (opp NULL, order c/asesor, order HUÉRFANO → hook gated): ${modeA.length}`);
      for (const x of modeA) console.log(`   - ${x}`);
      console.log(`\nMODO A' (opp NULL, order c/asesor, order YA LINKEADO):          ${modeA_linked.length}`);
      for (const x of modeA_linked) console.log(`   - ${x}`);
      console.log(`\nMODO B (opp asesor != order asesor, ambos no-null):            ${modeB.length}`);
      for (const x of modeB) console.log(`   - ${x}`);
      console.log(`\nOpp NULL y order tampoco tiene asesor (no corregible aún):     ${oppNullNoOrderAdvisor.length}`);
    },
    { source: "script" },
  );
}

main().catch((e: Error) => {
  console.error("falló:", e.message);
  process.exit(1);
});
