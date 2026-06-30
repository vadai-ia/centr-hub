import "server-only";
import { shopifyGraphql, type ShopifyAdminClientOptions } from "@/lib/shopify/admin-client";
import {
  normalizeDeliveryStatus,
  type DeliveryStatus,
  type DeliveryFulfillmentSnapshot,
} from "@/lib/shopify/delivery-status";

/**
 * Pull SOLO-LECTURA del estado de ENTREGA de un pedido vía GraphQL Admin
 * (cambio 0036). Lee los fulfillments del pedido (`displayStatus`,
 * `deliveredAt`, `trackingInfo`) y deriva el delivery_status normalizado.
 *
 * Scope: el objeto Fulfillment se lee con `read_orders` (validado contra el
 * schema — NO requiere `read_fulfillments`). Por eso NO suscribimos el
 * webhook fulfillments/* (que sí exigiría ese scope + re-instalación): el
 * cron horario refresca este dato con un pull, suficiente para la latencia
 * de Post-venta (dolores medidos en días).
 *
 * `Order.fulfillments(first:)` devuelve una LISTA de Fulfillment (no una
 * connection). Pedimos hasta 20 — más que suficiente para un pedido real.
 */

const ORDER_DELIVERY_QUERY = /* GraphQL */ `
  query OrderDelivery($id: ID!) {
    order(id: $id) {
      id
      fulfillments(first: 20) {
        status
        displayStatus
        deliveredAt
        trackingInfo {
          number
        }
      }
    }
  }
`;

interface OrderDeliveryGraphqlResponse {
  order: {
    id: string;
    fulfillments: Array<{
      status: string | null;
      displayStatus: string | null;
      deliveredAt: string | null;
      trackingInfo: Array<{ number: string | null }> | null;
    }>;
  } | null;
}

export interface OrderDeliveryResult {
  /** Estado de entrega normalizado, o null si no hay señal / pedido inexistente. */
  status: DeliveryStatus | null;
  /** displayStatus crudos de cada fulfillment (para audit/diagnóstico). */
  raw: string[];
  /** El pedido existe en Shopify. */
  found: boolean;
}

function toGid(shopifyOrderId: string): string {
  // Acepta tanto el id numérico ("12345") como un gid ya formado.
  return shopifyOrderId.startsWith("gid://")
    ? shopifyOrderId
    : `gid://shopify/Order/${shopifyOrderId}`;
}

/**
 * Trae el estado de entrega normalizado de un pedido. No lanza por "pedido
 * no encontrado" (devuelve found:false); sí propaga errores de red/scope
 * para que el caller (cron/backfill) decida reintentar.
 */
export async function fetchOrderDeliveryStatus(
  opts: ShopifyAdminClientOptions,
  shopifyOrderId: string,
): Promise<OrderDeliveryResult> {
  const data = await shopifyGraphql<OrderDeliveryGraphqlResponse>(
    opts,
    ORDER_DELIVERY_QUERY,
    { id: toGid(shopifyOrderId) },
  );

  const order = data.order;
  if (!order) return { status: null, raw: [], found: false };

  const fulfillments = order.fulfillments ?? [];
  const snapshots: DeliveryFulfillmentSnapshot[] = fulfillments.map((fu) => {
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

  return {
    status: normalizeDeliveryStatus(snapshots),
    raw: fulfillments.map((fu) => fu.displayStatus ?? "∅"),
    found: true,
  };
}
