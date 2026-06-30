import "server-only";
import { getOpportunityById } from "@/lib/db/opportunities";
import { findOrderByShopifyOrderId, updateOrder } from "@/lib/db/orders";
import { fetchOrderDeliveryStatus } from "@/lib/shopify/order-delivery";
import type { UUID } from "@/lib/types/database";

/**
 * Refresco SOLO-LECTURA del estado de entrega de la orden de una opp de
 * Post-venta (cambio 0036). Lee el estado de entrega actual desde Shopify
 * vía read_orders (pull) y lo persiste en `orders.delivery_status`. NO
 * mueve etapas — eso lo hace el motor (`applyPostventaTransition`) leyendo
 * la fila ya actualizada.
 *
 * Por qué un pull y no el webhook fulfillments/*: el cambio del carrier
 * (in_transit → delivered) no re-dispara orders/* de forma garantizada, y
 * suscribir fulfillments/* exigiría el scope read_fulfillments +
 * re-instalación de la app. El pull con read_orders (que ya tenemos) cubre
 * la latencia de Post-venta sin re-autorización.
 *
 * Reusado por el cron horario y por el correctivo backfill-order-delivery-
 * status. Idempotente: solo escribe si el valor cambió; nunca re-pull de
 * un pedido ya entregado (terminal por anti-retroceso).
 */

export type DeliveryRefreshResult =
  | { status: "updated"; from: string | null; to: string | null }
  | { status: "unchanged"; value: string | null }
  | { status: "skipped"; reason: string };

export async function refreshDeliveryStatusForOpp(
  opportunityId: UUID,
  shopDomain: string,
  organizationId: UUID,
): Promise<DeliveryRefreshResult> {
  const opp = await getOpportunityById(opportunityId);
  if (!opp) return { status: "skipped", reason: "opportunity_not_found" };
  if (opp.funnel !== "post_venta") {
    return { status: "skipped", reason: "not_post_venta" };
  }
  if (opp.cancelled_at) return { status: "skipped", reason: "opportunity_cancelled" };
  if (!opp.shopify_order_id) {
    return { status: "skipped", reason: "no_shopify_order_id" };
  }

  const order = await findOrderByShopifyOrderId(opp.shopify_order_id);
  if (!order) return { status: "skipped", reason: "order_not_found" };

  // Entregado es terminal para el motor (anti-retroceso): no re-consultar
  // Shopify por algo que ya no va a cambiar de etapa.
  if (order.delivery_status === "delivered") {
    return { status: "skipped", reason: "already_delivered" };
  }

  const result = await fetchOrderDeliveryStatus(
    { organizationId, shopDomain },
    opp.shopify_order_id,
  );
  if (!result.found) return { status: "skipped", reason: "order_not_found_in_shopify" };

  if (result.status === order.delivery_status) {
    return { status: "unchanged", value: order.delivery_status };
  }

  await updateOrder(order.id, { delivery_status: result.status });
  return { status: "updated", from: order.delivery_status, to: result.status };
}
