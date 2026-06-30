/* eslint-disable no-console */
/**
 * CORRECTIVO — pobla `orders.delivery_status` (cambio 0036) para las opps
 * de Post-venta ACTIVAS de una organización, leyendo el estado de entrega
 * actual desde Shopify vía GraphQL (scope read_orders — SIN re-autorización).
 *
 * Para qué: el motor de Post-venta ahora mueve "Envío en curso" / "Entregado"
 * por `delivery_status`, que las órdenes históricas NO tienen poblado. Este
 * correctivo lo trae una vez para que el dry-run del motor
 * (`maintenance:preview-postventa-transitions`) refleje el estado real ANTES
 * de habilitar el motor.
 *
 * SOLO toca `orders.delivery_status` — NO mueve etapas (eso lo hace el motor,
 * gateado por POSTVENTA_ENGINE_ENABLED). Read-only en --dry-run.
 *
 * Idempotente: re-ejecutable; solo escribe si el valor cambió.
 *
 * Uso:
 *   npm run maintenance:backfill-order-delivery-status -- --org-slug centr --dry-run
 *   npm run maintenance:backfill-order-delivery-status -- --org-slug centr
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getOpportunityById, listActivePostventaOppIds } from "@/lib/db/opportunities";
import { findOrderByShopifyOrderId, updateOrder } from "@/lib/db/orders";
import { fetchOrderDeliveryStatus } from "@/lib/shopify/order-delivery";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function parseArgs() {
  let orgSlug: string | null = null;
  let dryRun = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--dry-run") dryRun = true;
  }
  if (!orgSlug) {
    console.error("Uso: --org-slug <slug> [--dry-run]");
    process.exit(2);
  }
  return { orgSlug, dryRun };
}

async function main() {
  const { orgSlug, dryRun } = parseArgs();
  void getSupabaseAdminClient();
  const org = await getOrganizationBySlug(orgSlug);
  if (!org) {
    console.error(`org ${orgSlug} no encontrada`);
    process.exit(1);
  }
  if (!org.shopify_store_domain) {
    console.error(`org ${orgSlug} no tiene shopify_store_domain — no se puede consultar Shopify`);
    process.exit(1);
  }
  const shopDomain = org.shopify_store_domain;

  console.log(
    `\nBackfill delivery_status (${dryRun ? "DRY-RUN, solo lectura" : "ESCRITURA"}) en "${org.name}".\n`,
  );

  await withTenantContext(
    org.id as UUID,
    async () => {
      const oppIds = await listActivePostventaOppIds();
      console.log(`Opps de Post-venta activas: ${oppIds.length}\n`);

      const counters: Record<string, number> = {};
      const bump = (k: string) => (counters[k] = (counters[k] ?? 0) + 1);
      const rows: string[] = [];

      for (const oppId of oppIds) {
        const opp = await getOpportunityById(oppId);
        if (!opp?.shopify_order_id) {
          bump("skip:no_shopify_order_id");
          continue;
        }
        const order = await findOrderByShopifyOrderId(opp.shopify_order_id);
        if (!order) {
          bump("skip:order_not_found");
          continue;
        }
        if (order.delivery_status === "delivered") {
          bump("skip:already_delivered");
          continue;
        }

        const ref = opp.display_reference ?? opp.shopify_order_id;
        let result;
        try {
          result = await fetchOrderDeliveryStatus(
            { organizationId: org.id as UUID, shopDomain },
            opp.shopify_order_id,
          );
        } catch (err) {
          bump("error:shopify_pull_failed");
          rows.push(`  ! ${ref} :: pull falló: ${(err as Error).message}`);
          continue;
        }

        if (!result.found) {
          bump("skip:order_not_in_shopify");
          continue;
        }

        const from = order.delivery_status;
        const to = result.status;
        if (from === to) {
          bump(`unchanged:${to ?? "∅"}`);
          continue;
        }

        bump(`change:${from ?? "∅"}→${to ?? "∅"}`);
        rows.push(
          `  ${dryRun ? "→" : "✓"} ${ref} :: delivery ${from ?? "∅"} ⇒ ${to ?? "∅"}  [shopify displayStatus: ${result.raw.join(", ") || "∅"}]`,
        );

        if (!dryRun) {
          await updateOrder(order.id, { delivery_status: to });
        }
      }

      console.log(`Cambios (${rows.length}):`);
      console.log(rows.length ? rows.join("\n") : "  (ninguno)");

      console.log("\nResumen por categoría:");
      for (const k of Object.keys(counters).sort()) {
        console.log(`  ${k}: ${counters[k]}`);
      }
      console.log(
        dryRun
          ? "\n(DRY-RUN — nada se escribió. Quita --dry-run para persistir.)\n"
          : "\n(delivery_status poblado. Ahora corre el dry-run del motor: maintenance:preview-postventa-transitions.)\n",
      );
    },
    { source: "script" },
  );
}

main().catch((err: Error) => {
  console.error("backfill-order-delivery-status falló:", err.message);
  process.exit(1);
});
