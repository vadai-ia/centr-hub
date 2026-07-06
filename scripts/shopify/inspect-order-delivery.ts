/* eslint-disable no-console */
/**
 * DIAGNÓSTICO SOLO-LECTURA del estado de entrega (cambio 0036). Muestra,
 * para cross-check contra la columna "Estado de la entrega" de Shopify:
 *
 *  (A) Las 44 opps de Post-venta ACTIVAS y, por cada una, el pedido que
 *      referencian, su displayFulfillmentStatus (preparación) y el estado
 *      de entrega crudo de sus fulfillments (displayStatus / deliveredAt /
 *      tracking) + el `delivery_status` que DERIVARÍA el motor. Sirve para
 *      ver si alguna de las 44 está "Preparada" (y por qué el backfill dio
 *      casi todo ∅ = pedidos aún "No preparado").
 *
 *  (B) Pedidos ESPECÍFICOS por nombre (--order "#1002" --order "#1007"),
 *      aunque NO estén entre las 44, con el mismo detalle crudo + qué opps
 *      los referencian. Confirma que la lectura y el mapeo funcionan para
 *      los pedidos que SÍ muestran "Seguimiento añadido" / "Entregado".
 *
 * NO escribe nada. Scope: read_orders (igual que el motor).
 *
 * Uso:
 *   npm run shopify:inspect-order-delivery -- --org-slug centr
 *   npm run shopify:inspect-order-delivery -- --org-slug centr --order "#1002" --order "#1007"
 *   npm run shopify:inspect-order-delivery -- --org-slug centr --limit 60 --order "#1002"
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getOpportunityById, listActivePostventaOppIds } from "@/lib/db/opportunities";
import { findOrderByShopifyOrderId } from "@/lib/db/orders";
import { listPipelineStages } from "@/lib/db/pipeline";
import { shopifyGraphql } from "@/lib/shopify/admin-client";
import {
  normalizeDeliveryStatus,
  type DeliveryFulfillmentSnapshot,
} from "@/lib/shopify/delivery-status";
import type { PipelineStageRow, UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

interface RawFulfillment {
  status: string | null;
  displayStatus: string | null;
  deliveredAt: string | null;
  trackingInfo: Array<{ number: string | null; company: string | null }> | null;
}
interface RawOrder {
  id: string;
  name: string | null;
  displayFulfillmentStatus: string | null;
  fulfillments: RawFulfillment[];
}

const ORDER_FIELDS = /* GraphQL */ `
  id
  name
  displayFulfillmentStatus
  fulfillments(first: 20) {
    status
    displayStatus
    deliveredAt
    trackingInfo { number company }
  }
`;

function parseArgs() {
  let orgSlug: string | null = null;
  let limit = 60;
  const orders: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--order") orders.push(argv[++i] ?? "");
    else if (argv[i] === "--limit") limit = Number(argv[++i] ?? "60");
  }
  if (!orgSlug) {
    console.error('Uso: --org-slug <slug> [--order "#1002"]... [--limit N]');
    process.exit(2);
  }
  return { orgSlug, limit, orders: orders.filter(Boolean) };
}

function toSnapshots(fulfillments: RawFulfillment[]): DeliveryFulfillmentSnapshot[] {
  return fulfillments.map((fu) => {
    const status = (fu.status ?? "").trim().toLowerCase();
    const hasTracking = Array.isArray(fu.trackingInfo)
      ? fu.trackingInfo.some((t) => Boolean(t?.number))
      : false;
    return {
      cancelled:
        status === "cancelled" || status === "error" || status === "failure",
      displayStatus: fu.displayStatus,
      deliveredAt: fu.deliveredAt,
      hasTracking,
    };
  });
}

function describeFulfillments(fulfillments: RawFulfillment[]): string {
  if (fulfillments.length === 0) return "(sin fulfillments)";
  return fulfillments
    .map((fu, i) => {
      const tn = (fu.trackingInfo ?? [])
        .map((t) => t.number)
        .filter(Boolean)
        .join("/");
      return `#${i + 1} status=${fu.status ?? "∅"} displayStatus=${fu.displayStatus ?? "∅"} deliveredAt=${fu.deliveredAt ?? "∅"} tracking=${tn || "∅"}`;
    })
    .join(" | ");
}

async function fetchOrderByGid(
  ctx: { organizationId: UUID; shopDomain: string },
  gid: string,
): Promise<RawOrder | null> {
  const data = await shopifyGraphql<{ order: RawOrder | null }>(
    ctx,
    `query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`,
    { id: gid },
  );
  return data.order;
}

async function fetchOrdersByName(
  ctx: { organizationId: UUID; shopDomain: string },
  name: string,
): Promise<RawOrder[]> {
  const data = await shopifyGraphql<{ orders: { nodes: RawOrder[] } }>(
    ctx,
    `query($q: String!) { orders(first: 10, query: $q) { nodes { ${ORDER_FIELDS} } } }`,
    { q: `name:${name}` },
  );
  return data.orders.nodes ?? [];
}

async function main() {
  const { orgSlug, limit, orders: orderNames } = parseArgs();
  void getSupabaseAdminClient();
  const org = await getOrganizationBySlug(orgSlug);
  if (!org) {
    console.error(`org ${orgSlug} no encontrada`);
    process.exit(1);
  }
  if (!org.shopify_store_domain) {
    console.error(`org ${orgSlug} no tiene shopify_store_domain`);
    process.exit(1);
  }
  const ctx = { organizationId: org.id as UUID, shopDomain: org.shopify_store_domain };

  await withTenantContext(
    org.id as UUID,
    async () => {
      const stages = await listPipelineStages("post_venta");
      const stageName = new Map<UUID, string>(
        stages.map((s: PipelineStageRow) => [s.id, s.name]),
      );
      const nameOf = (id: UUID | null | undefined) =>
        id ? stageName.get(id) ?? id : "(?)";

      // (A) Las opps de Post-venta activas.
      const oppIds = (await listActivePostventaOppIds()).slice(0, limit);
      console.log(
        `\n=== (A) Opps de Post-venta activas (${oppIds.length}) — pedido, preparación y ENTREGA ===\n`,
      );
      let fulfilledCount = 0;
      const activePvOrderIds = new Set<string>();
      for (const oppId of oppIds) {
        const opp = await getOpportunityById(oppId);
        if (!opp?.shopify_order_id) {
          console.log(`  · [${nameOf(opp?.stage_id)}] (sin shopify_order_id)`);
          continue;
        }
        activePvOrderIds.add(opp.shopify_order_id);
        const dbOrder = await findOrderByShopifyOrderId(opp.shopify_order_id);
        let raw: RawOrder | null = null;
        try {
          raw = await fetchOrderByGid(ctx, `gid://shopify/Order/${opp.shopify_order_id}`);
        } catch (err) {
          console.log(
            `  ! [${nameOf(opp.stage_id)}] order ${opp.shopify_order_id} pull falló: ${(err as Error).message}`,
          );
          continue;
        }
        if (!raw) {
          console.log(
            `  · [${nameOf(opp.stage_id)}] order ${opp.shopify_order_id} → NO existe en Shopify`,
          );
          continue;
        }
        const derived = normalizeDeliveryStatus(toSnapshots(raw.fulfillments));
        if (raw.fulfillments.length > 0) fulfilledCount += 1;
        console.log(
          `  ${derived ? "→" : "·"} ${raw.name ?? opp.shopify_order_id} [${nameOf(opp.stage_id)}]  fin_db=${dbOrder?.financial_status ?? "?"}  prep=${raw.displayFulfillmentStatus ?? "∅"}  ENTREGA_derivada=${derived ?? "∅"}\n       ${describeFulfillments(raw.fulfillments)}`,
        );
      }
      console.log(
        `\n  Resumen (A): ${fulfilledCount}/${oppIds.length} opps activas tienen fulfillment (pedido "Preparado"); el resto son "No preparado" → entrega ∅ (correcto).`,
      );

      // (B) Pedidos específicos por nombre.
      if (orderNames.length > 0) {
        console.log(
          `\n=== (B) Pedidos específicos por nombre (${orderNames.join(", ")}) ===\n`,
        );
        for (const name of orderNames) {
          let found: RawOrder[] = [];
          try {
            found = await fetchOrdersByName(ctx, name);
          } catch (err) {
            console.log(`  ! ${name}: búsqueda falló: ${(err as Error).message}`);
            continue;
          }
          if (found.length === 0) {
            console.log(`  · ${name}: no encontrado en Shopify`);
            continue;
          }
          for (const raw of found) {
            const derived = normalizeDeliveryStatus(toSnapshots(raw.fulfillments));
            const numericId = raw.id.split("/").pop() ?? "";
            const dbOrder = await findOrderByShopifyOrderId(numericId);
            const inActivePv = activePvOrderIds.has(numericId);
            console.log(
              `  ${raw.name ?? raw.id}  prep=${raw.displayFulfillmentStatus ?? "∅"}  ENTREGA_derivada=${derived ?? "∅"}\n` +
                `       ${describeFulfillments(raw.fulfillments)}\n` +
                `       en BD local: ${dbOrder ? `sí (order ${numericId})` : "NO (pedido no sincronizado como fila orders)"}\n` +
                `       ¿entre las opps Post-venta activas?: ${inActivePv ? "SÍ" : "NO — por eso no aparece en el backfill de las 44"}`,
            );
          }
        }
      }

      console.log("\n(SOLO LECTURA — nada se escribió.)\n");
    },
    { source: "script" },
  );
}

main().catch((err: Error) => {
  console.error("inspect-order-delivery falló:", err.message);
  process.exit(1);
});
