import "server-only";
import {
  getInngestClient,
  type ShopifyWebhookEnvelope,
} from "@/lib/inngest/client";
import { runWebhookWorker } from "@/lib/inngest/helpers";
import {
  mapOrderWebhookToNormalized,
  type NormalizedOrder,
} from "@/lib/shopify/mappers";
import { parseShopifyTags } from "@/lib/services/tag-parser";
import { matchContactIdentity } from "@/lib/services/identity-matching";
import { shouldApplyRecordUpdate } from "@/lib/services/last-write-wins";
import { hydrateContactFromEmbeddedShopifyCustomer } from "@/lib/inngest/functions/customers";
import {
  createContact,
  findContactByShopifyCustomerId,
} from "@/lib/db/contacts";
import {
  createOrder,
  findOrderByShopifyOrderId,
  replaceOrderLineItems,
  updateOrder,
} from "@/lib/db/orders";
import {
  findOpportunityByDraftOrderId,
  findPostventaChildOpportunityId,
  findVentaOpportunityIdByShopifyOrderId,
} from "@/lib/db/opportunities";
import {
  reattributePostventaChildForOrder,
  reattributeVentaOpportunityForOrder,
} from "@/lib/services/f1-to-f2-trigger";
import {
  applyPostventaTransition,
  isPostventaEngineEnabled,
} from "@/lib/services/postventa-transition";
import { recordAuditEvent } from "@/lib/db/operational";
import type { Json, OrderRow, UUID } from "@/lib/types/database";

/**
 * Workers de Orders (6 topics).
 *
 * Decisión clave (Sección 3.3.5): orders/paid NO dispara F1→F2.
 * Ese trigger atómico vive en M7. Aquí solo marcamos
 * financial_status='paid' y paid_at.
 *
 * Atribución por tag de Order:
 *   - Las tags vienen tanto en la Order como en su Customer.
 *   - El parser corre sobre las tags de la ORDER porque pueden
 *     diferir de las del Customer (el vendedor pone la tag al
 *     crear el Draft Order según Ajuste post-Discovery 2 #10).
 *   - El asesor de la Order puede diferir del asesor del Contact
 *     y de la Opportunity — esto es por diseño (la Order es la
 *     unidad de atribución de revenue).
 */

const inngest = getInngestClient();

async function resolveContactIdForOrder(
  normalized: NormalizedOrder,
  effectiveUpdatedAt: string,
): Promise<UUID | null> {
  if (!normalized.shopifyCustomerId) return null;
  const existing = await findContactByShopifyCustomerId(normalized.shopifyCustomerId);
  if (existing) return existing.id;

  // Fix M3 (ver ERRORES.md): el payload de orders/* trae el OBJETO
  // customer completo (no solo el id). Si llegamos acá significa que
  // todavía no hay contacto local — usamos esos datos para hidratarlo
  // en vez de crear un stub vacío. El helper aplica identity match
  // por phone/email + LWW por campo, así que reusa la misma lógica
  // que `customers/create`.
  if (normalized.embeddedCustomer) {
    const customerUpdatedAt =
      normalized.embeddedCustomer.updatedAt
      ?? normalized.embeddedCustomer.createdAt
      ?? effectiveUpdatedAt;
    const hydrated = await hydrateContactFromEmbeddedShopifyCustomer(
      normalized.embeddedCustomer,
      customerUpdatedAt,
    );
    return hydrated.id;
  }

  // Fallback defensivo: customer.id presente pero el objeto venía sin
  // datos (caso atípico — Shopify normalmente incluye el body). Mismo
  // path antiguo: identity match por id + stub vacío si no hay match.
  const match = await matchContactIdentity({
    source: "shopify",
    shopifyCustomerId: normalized.shopifyCustomerId,
  });
  if (match.match) return match.match.id;

  const created = await createContact({
    full_name: null,
    email: null,
    phone: null,
    address: null,
    internal_note: null,
    shopify_state: null,
    shopify_tags: [],
    assigned_advisor_id: null,
    shopify_customer_id: normalized.shopifyCustomerId,
    whaapy_contact_id: null,
    missing_phone: true,
    field_metadata: {} as Json,
    last_modified_at: effectiveUpdatedAt,
    last_modified_source: "shopify",
    deleted_in_shopify: false,
    deleted_in_whaapy: false,
    anonymized_at: null,
    last_whaapy_activity_at: null,
  });
  return created.id;
}

async function resolveTagAssignmentForOrder(
  normalized: NormalizedOrder,
): Promise<UUID | null> {
  const result = await parseShopifyTags({
    rawTags: normalized.tags,
    source: "order",
    shopifyEntityId: normalized.shopifyOrderId,
  });
  return result.assignedMembership?.id ?? null;
}

async function upsertOrderShell(
  normalized: NormalizedOrder,
  effectiveUpdatedAt: string,
): Promise<OrderRow> {
  const contactId = await resolveContactIdForOrder(normalized, effectiveUpdatedAt);
  if (!contactId) {
    throw new Error(
      `orders_worker: order ${normalized.shopifyOrderId} sin customer asociado — no se puede atribuir`,
    );
  }

  const opportunityId = await resolveVentaOpportunityIdForOrder(normalized);
  const tagAssignment = await resolveTagAssignmentForOrder(normalized);

  const existing = await findOrderByShopifyOrderId(normalized.shopifyOrderId);
  if (!existing) {
    const created = await createOrder({
      contact_id: contactId,
      assigned_advisor_id: tagAssignment ?? null,
      opportunity_id: opportunityId,
      shopify_order_id: normalized.shopifyOrderId,
      shopify_name: normalized.shopifyName,
      financial_status: normalized.financialStatus,
      fulfillment_status: normalized.fulfillmentStatus,
      total_amount: normalized.totalAmount,
      subtotal: normalized.subtotalAmount,
      taxes_amount: normalized.taxesAmount,
      shipping_amount: normalized.shippingAmount,
      discount_amount: normalized.discountAmount,
      currency: normalized.currency,
      cancellation_reason: normalized.cancellationReason,
      source: normalized.source,
      shopify_tags: normalized.tags,
      last_modified_at: effectiveUpdatedAt,
      last_modified_source: "shopify",
      paid_at: normalized.paidAt,
      cancelled_at: normalized.cancelledAt,
      // Fecha real de creación del pedido en Shopify (no la de BD).
      // El dashboard cuenta pedidos por este campo (migración 0024).
      shopify_created_at: normalized.createdAt,
      // Estado de entrega derivado de los fulfillments embebidos del
      // payload (migración 0036). NULL si el pedido aún no tiene
      // fulfillment con seguimiento. El cron horario lo refresca vía pull.
      delivery_status: normalized.deliveryStatus,
    });
    await replaceOrderLineItems(
      created.id,
      normalized.lineItems.map(mapLineItemForOrder),
    );
    return created;
  }

  if (!shouldApplyRecordUpdate(existing.last_modified_at, effectiveUpdatedAt)) {
    return existing;
  }

  const patch: Record<string, unknown> = {
    contact_id: contactId,
    opportunity_id: opportunityId ?? existing.opportunity_id,
    financial_status: normalized.financialStatus,
    fulfillment_status: normalized.fulfillmentStatus,
    total_amount: normalized.totalAmount,
    subtotal: normalized.subtotalAmount,
    taxes_amount: normalized.taxesAmount,
    shipping_amount: normalized.shippingAmount,
    discount_amount: normalized.discountAmount,
    currency: normalized.currency,
    cancellation_reason: normalized.cancellationReason,
    source: normalized.source,
    shopify_tags: normalized.tags,
    paid_at: normalized.paidAt ?? existing.paid_at,
    cancelled_at: normalized.cancelledAt ?? existing.cancelled_at,
    // Estado de entrega (0036): refresca desde los fulfillments embebidos
    // del payload, pero NO lo borra si este update no trae fulfillments
    // (ej. un cambio de nota dispara orders/updated sin fulfillments). El
    // cron horario es la fuente de refresco autoritativa vía pull.
    delivery_status: normalized.deliveryStatus ?? existing.delivery_status,
    last_modified_at: effectiveUpdatedAt,
    last_modified_source: "shopify",
    // Fecha real de creación en Shopify: inmutable allá. Coalesce
    // defensivo para no borrarla si un payload llegara sin created_at.
    shopify_created_at: normalized.createdAt ?? existing.shopify_created_at,
  };
  if (tagAssignment !== null) patch.assigned_advisor_id = tagAssignment;

  const updated = await updateOrder(existing.id, patch);
  await replaceOrderLineItems(updated.id, normalized.lineItems.map(mapLineItemForOrder));
  return updated;
}

function mapLineItemForOrder(li: NormalizedOrder["lineItems"][number]) {
  return {
    shopify_product_id: li.shopifyProductId,
    shopify_variant_id: li.shopifyVariantId,
    title: li.title,
    sku: li.sku,
    quantity: li.quantity,
    variant_title: li.variantTitle,
    original_unit_price: li.originalUnitPrice,
    discount_amount: li.discountAmount,
    final_price: li.finalPrice,
    weight_grams: li.weightGrams,
    taxable: li.taxable,
  };
}

/**
 * Resuelve la opp de Venta (F1) a la que pertenece esta orden, para
 * enlazarla (`orders.opportunity_id`) y para que los hooks de
 * re-atribución 0022/0023 puedan correr.
 *
 * Orden de resolución:
 *   1. Por `draft_order_id` del payload — el camino "canónico", pero
 *      Shopify NO lo envía en el webhook de orders en este setup, así
 *      que casi siempre da null (toda orden quedaba huérfana → los hooks
 *      nunca disparaban; ver ERRORES.md "Opp 'sin asignar' …").
 *   2. Fallback por `shopify_order_id`: la opp de Venta espeja ese campo
 *      (lo puebla el trigger F1→F2 al ganar), así que aunque la orden no
 *      conozca el draft, la opp sí conoce la orden. Cierra la asimetría.
 *
 * Si la opp todavía no espeja el `shopify_order_id` (carrera: la orden
 * aterrizó antes de que el draft se completara), devuelve null — ese caso
 * lo cubre la completación del draft (trigger F1→F2 lee la orden) y, como
 * red, el cron horario de reconciliación.
 */
async function resolveVentaOpportunityIdForOrder(
  normalized: NormalizedOrder,
): Promise<UUID | null> {
  if (normalized.shopifyDraftOrderId) {
    const opp = await findOpportunityByDraftOrderId(normalized.shopifyDraftOrderId);
    if (opp) return opp.id;
  }
  return findVentaOpportunityIdByShopifyOrderId(normalized.shopifyOrderId);
}

/**
 * Hook inline del motor de transiciones de Post-venta (M3v2). Resuelve la
 * hija de Post-venta a partir del pedido (orden → opp de Venta padre →
 * hija) y la mueve a la etapa que corresponde al estado del pedido.
 *
 * Resolución del padre: la opp de Venta espeja `shopify_order_id` (lo
 * puebla el trigger F1→F2 al ganar). `order.opportunity_id` ya suele
 * apuntar al padre; fallback por `shopify_order_id`. Sin padre o sin hija
 * (aún no completó el draft) → no-op silencioso.
 *
 * No-fatal por diseño: cualquier fallo se loguea y se traga — la ingesta
 * del pedido NO debe romperse por el motor, y el cron horario reintenta.
 */
async function applyPostventaTransitionForOrder(order: OrderRow): Promise<void> {
  // Kill switch: el motor automático no mueve nada hasta que el operador
  // lo habilite tras revisar el dry-run (M3v2).
  if (!isPostventaEngineEnabled()) return;
  try {
    const ventaOppId =
      order.opportunity_id ??
      (await findVentaOpportunityIdByShopifyOrderId(order.shopify_order_id));
    if (!ventaOppId) return;
    const childId = await findPostventaChildOpportunityId(ventaOppId);
    if (!childId) return;
    await applyPostventaTransition(childId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `postventa-transition inline: order ${order.shopify_order_id} falló:`,
      (err as Error).message,
    );
  }
}

// ============================================================
// Topics (6)
// ============================================================

type InngestRetries =
  | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
  | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20;

function makeOrderWorker(args: {
  id: string;
  event:
    | "shopify/orders.create"
    | "shopify/orders.updated"
    | "shopify/orders.paid"
    | "shopify/orders.cancelled"
    | "shopify/orders.fulfilled"
    | "shopify/orders.partially_fulfilled";
  topic: string;
  retries?: InngestRetries;
}) {
  return inngest.createFunction(
    {
      id: args.id,
      retries: args.retries ?? 5,
      triggers: [{ event: args.event }],
    },
    async ({ event }) => {
      const envelope = event.data as unknown as ShopifyWebhookEnvelope;
      return runWebhookWorker(envelope, args.topic, async (env) => {
        const normalized = mapOrderWebhookToNormalized(env.payload);
        const effectiveUpdatedAt =
          normalized.updatedAt ?? normalized.paidAt ?? normalized.createdAt ?? new Date().toISOString();
        const order = await upsertOrderShell(normalized, effectiveUpdatedAt);

        if (args.event === "shopify/orders.paid" && order.financial_status !== "paid") {
          // Defensa: si el upsert por shape se desfasó, asegurar paid.
          await updateOrder(order.id, {
            financial_status: "paid",
            paid_at: order.paid_at ?? effectiveUpdatedAt,
          });
        }
        if (args.event === "shopify/orders.paid") {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "order_paid_received",
            entityType: "order",
            entityId: order.id,
            payload: { shopify_order_id: normalized.shopifyOrderId },
          });
        }

        // Hooks de re-atribución (fix 0022 + 0023): si esta orden tiene
        // asesor y está vinculada a una opp de Venta (F1), realinea dos
        // filas distintas sin colisión —
        //   (a) la F1 de Venta sin asesor (rellena NULL, fix 0023): cierra
        //       la ventana de carrera en que la opp avanzó por la tag del
        //       draft antes de que la orden aterrizara con su tag. SOLO
        //       rellena NULL — nunca pisa un asesor ya puesto.
        //   (b) la hija de Post-venta (fix 0022): alinea el asesor de la
        //       hija con el de la orden.
        // Ambas RPC son idempotentes y tocan funnels distintos (venta vs
        // post_venta), así que no se pisan ni duplican trabajo.
        //
        // Fix Eduardo Badir: la condición resuelve la opp de Venta por
        // `order.opportunity_id` (ya enlazado arriba por shopify_order_id)
        // O por el fallback directo a shopify_order_id — antes el gate
        // exigía `order.opportunity_id`, que era SIEMPRE NULL (Shopify no
        // manda draft_order_id), y por eso los hooks NUNCA disparaban en
        // vivo. Ver ERRORES.md "Opp 'sin asignar' …".
        const ventaOpportunityId =
          order.opportunity_id ??
          (order.assigned_advisor_id
            ? await findVentaOpportunityIdByShopifyOrderId(order.shopify_order_id)
            : null);
        if (ventaOpportunityId && order.assigned_advisor_id) {
          await reattributeVentaOpportunityForOrder({
            opportunityId: ventaOpportunityId,
            source: args.topic,
          });
          await reattributePostventaChildForOrder({
            parentOpportunityId: ventaOpportunityId,
            source: args.topic,
          });
        }

        // Motor de transiciones de Post-venta (M3v2): mueve la hija de
        // Post-venta a la etapa que corresponde al estado del pedido
        // (pago/preparación → etapas 1-4; cancelado/reembolsado → Caso
        // problemático). Transición INMEDIATA al recibir el webhook; el
        // cron horario es la red de seguridad. No-fatal: un fallo aquí no
        // debe romper la ingesta del pedido. El driver respeta
        // backfill_in_progress por su cuenta.
        await applyPostventaTransitionForOrder(order);

        return { orderId: order.id };
      });
    },
  );
}

export const ordersCreate = makeOrderWorker({
  id: "shopify-orders-create",
  event: "shopify/orders.create",
  topic: "orders/create",
});
export const ordersUpdated = makeOrderWorker({
  id: "shopify-orders-updated",
  event: "shopify/orders.updated",
  topic: "orders/updated",
});
export const ordersPaid = makeOrderWorker({
  id: "shopify-orders-paid",
  event: "shopify/orders.paid",
  topic: "orders/paid",
});
export const ordersCancelled = makeOrderWorker({
  id: "shopify-orders-cancelled",
  event: "shopify/orders.cancelled",
  topic: "orders/cancelled",
});
export const ordersFulfilled = makeOrderWorker({
  id: "shopify-orders-fulfilled",
  event: "shopify/orders.fulfilled",
  topic: "orders/fulfilled",
});
export const ordersPartiallyFulfilled = makeOrderWorker({
  id: "shopify-orders-partially-fulfilled",
  event: "shopify/orders.partially_fulfilled",
  topic: "orders/partially_fulfilled",
});

export const orderFunctions = [
  ordersCreate,
  ordersUpdated,
  ordersPaid,
  ordersCancelled,
  ordersFulfilled,
  ordersPartiallyFulfilled,
];
