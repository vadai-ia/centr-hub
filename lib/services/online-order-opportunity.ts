import "server-only";
import { createOpportunity } from "@/lib/db/opportunities";
import { updateOrder } from "@/lib/db/orders";
import { recordAuditEvent } from "@/lib/db/operational";
import { resolvePostventaEngineStages } from "@/lib/services/postventa-transition";
import { ONLINE_ORDER_SOURCE } from "@/lib/constants";
import type { Json, OrderRow, UUID } from "@/lib/types/database";

/**
 * Oportunidad de Post-venta para una COMPRA ONLINE.
 *
 * Una venta que entra sola por la tienda no tiene Draft Order, y toda la
 * cadena de oportunidades cuelga de ahí: sin borrador no hay opp de Venta, y
 * sin ella el trigger F1→F2 (0027) nunca crea la hija de Post-venta. Resultado
 * medido en producción: **294 de 294 pedidos online sin ninguna oportunidad**
 * — invisibles para Post-venta, que no podía darles seguimiento.
 *
 * Este servicio cierra ese hueco creando la hija directamente, sin madre.
 *
 * ## Decisiones, todas pedidas por Post-venta
 *
 * - **Nace en "Pago confirmado"** (posición 2 de la zona del motor), no en la
 *   etapa inicial: una compra online nunca pasó por cotización, así que
 *   arrancarla en "Cotización completada" sería mentir sobre su historia. De
 *   ahí el motor la mueve solo conforme avanza la entrega.
 * - **Sin asesor.** Nadie la vendió. Post-venta prefirió dejarlas sin asignar
 *   y decidir después caso por caso, en vez de atribuirlas a alguien por
 *   defecto y ensuciar sus métricas.
 * - **El Customer Success sí se asigna solo**, vía el trigger de 0047 — es
 *   quien las va a atender.
 *
 * ## Idempotencia
 *
 * El disparador son los webhooks `orders/*`, que llegan varias veces por el
 * mismo pedido (create, updated, paid, fulfilled). La guarda es
 * `order.opportunity_id`: si el pedido ya tiene opp, no se crea otra. Se
 * enlaza en la misma operación que la creación para que un reintento no deje
 * una opp huérfana y cree una segunda.
 */

export type OnlineOrderOpportunityResult =
  | { created: true; opportunityId: UUID }
  | { created: false; reason: OnlineOrderSkipReason };

export type OnlineOrderSkipReason =
  | "not_online"
  | "not_paid"
  | "already_linked"
  | "missing_contact"
  | "stages_unresolved";

export async function ensureOnlineOrderOpportunity(
  order: OrderRow,
): Promise<OnlineOrderOpportunityResult> {
  if (order.source !== ONLINE_ORDER_SOURCE) {
    return { created: false, reason: "not_online" };
  }
  // Solo pagadas: un pedido online pendiente de pago todavía no es una venta,
  // y meterlo al tablero de Post-venta le daría trabajo a Elías sobre algo
  // que puede no concretarse. Si después se paga, `orders/paid` vuelve a
  // pasar por aquí.
  if (order.financial_status !== "paid") {
    return { created: false, reason: "not_paid" };
  }
  // Idempotencia: los webhooks de un mismo pedido llegan varias veces.
  if (order.opportunity_id) {
    return { created: false, reason: "already_linked" };
  }
  if (!order.contact_id) {
    return { created: false, reason: "missing_contact" };
  }

  const stages = await resolvePostventaEngineStages();
  if (!stages) {
    // El funnel de Post-venta no tiene la forma esperada en esta org: el
    // motor tampoco opera aquí. No es un fallo del pedido.
    return { created: false, reason: "stages_unresolved" };
  }

  const opp = await createOpportunity({
    funnel: "post_venta",
    stage_id: stages.zoneByPosition[2].id,
    contact_id: order.contact_id,
    // Sin asesor a propósito: nadie vendió esto (ver cabezal).
    assigned_advisor_id: null,
    parent_opportunity_id: null,
    shopify_draft_order_id: null,
    shopify_order_id: order.shopify_order_id,
    // Sin borrador que mostrar: la card enseña el folio del PEDIDO, que la
    // capa de datos resuelve desde `orders.shopify_name`.
    display_reference: null,
    actual_amount: order.total_amount,
    estimated_amount: null,
    currency: order.currency,
    probability_override: null,
    weighted_amount: null,
    loss_reason_id: null,
    invoice_url: null,
    note: null,
    shipping_address: null,
    won_at: null,
    lost_at: null,
    invoice_sent_at: null,
    cancelled_at: null,
    cancellation_source: null,
    cancellation_note: null,
    // Fecha real del pedido en Shopify, no la de ingesta: el tablero y el
    // dashboard cuentan por la fecha real (0024/0025).
    shopify_created_at: order.shopify_created_at,
    last_modified_at: new Date().toISOString(),
    last_modified_source: "platform",
  });

  // Enlace inmediato: es lo que hace idempotente al siguiente webhook.
  await updateOrder(order.id, { opportunity_id: opp.id as UUID });

  await recordAuditEvent({
    actorUserId: null,
    eventType: "online_order_opportunity_created",
    entityType: "opportunity",
    entityId: opp.id as UUID,
    payload: {
      order_id: order.id,
      shopify_order_id: order.shopify_order_id,
      shopify_name: order.shopify_name,
      stage: stages.zoneByPosition[2].name,
    } as Json,
  });

  return { created: true, opportunityId: opp.id as UUID };
}

