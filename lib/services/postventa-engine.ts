/**
 * Motor de transiciones automáticas de Post-venta — M3v2.
 *
 * NÚCLEO PURO (sin efectos, sin acceso a BD): dado el estado de pago y
 * preparación de un pedido de Shopify, decide a qué etapa del Funnel
 * Post-venta debe estar la oportunidad asociada.
 *
 * Mapeo confirmado por Centr (cambio 0036 — Envío/Entregado por ENTREGA):
 *
 *   | Etapa Post-venta      | Estado del pedido en Shopify          |
 *   |-----------------------|---------------------------------------|
 *   | Cotización completada | pago = pendiente                      |
 *   | Pago confirmado       | pago = pagado                         |
 *   | Envío en curso        | entrega = en curso ("Seguimiento      |
 *   |                       |   añadido" / en tránsito, no entregado)|
 *   | Entregado             | entrega = entregado al cliente        |
 *
 * CAMBIO vs M3v2: "Envío en curso" y "Entregado" YA NO se rigen por el
 * estado de PREPARACIÓN del pedido (`fulfillment_status`: partial/fulfilled
 * = ¿se despacharon los ítems?), sino por el estado de ENTREGA real
 * (`delivery_status`, derivado de los fulfillments — ver
 * lib/shopify/delivery-status.ts). Razón: "Entregado" debe reflejar la
 * entrega al cliente, no que el pedido se haya despachado. `fulfillment_status`
 * ya NO participa en la decisión.
 *
 * Precedencia (decidida en el diagnóstico del cambio): **entrega precede a
 * pago**. Pago y entrega coexisten (un pedido pagado sigue pagado mientras
 * viaja). Se evalúa primero la entrega; solo si NO hay señal de entrega se
 * cae al estado de pago. Un pedido sin estado de entrega (aún no despachado
 * o sin seguimiento) se queda en su etapa de pago — nunca en etapa inválida.
 *
 * Cancelado / reembolsado: los tres estados problema (`cancelled`,
 * `refunded`, `partially_refunded`) mandan la opp a "Caso problemático"
 * para revisión humana — el motor entra a esa etapa pero NUNCA saca de ahí
 * (one-way; el cierre lo hace una persona). Se evalúan ANTES que entrega/pago.
 *
 * Pago parcial: `partially_paid` (ej. "Anticipo 50%") se trata como
 * PENDIENTE — la opp se queda en "Cotización completada" hasta que el pago
 * esté completo (`paid`). "Pago confirmado" = pagado 100%.
 *
 * Por qué este módulo NO es `server-only`: es una función pura sobre tipos
 * planos, sin dependencias de runtime; así se testea directo bajo Vitest y
 * el driver server-side (postventa-transition.ts) la reusa.
 */

/** Posición (1-4) de la etapa de zona automática que corresponde. */
export type PostventaZonePosition = 1 | 2 | 3 | 4;

export type PostventaTarget =
  /** Mover a la etapa de zona en esa posición (1-4). */
  | { kind: "advance"; position: PostventaZonePosition; reason: string }
  /** Mover a "Caso problemático" (cancelado/reembolsado). */
  | { kind: "problem"; reason: string }
  /** Estado inesperado/no mapeable: no mover, registrar para diagnóstico. */
  | { kind: "none"; reason: string };

// Valores de financial_status de Shopify (orders.financial_status, NOT NULL).
const FIN_PAID = "paid";
const FIN_PENDING = "pending";
const FIN_PARTIALLY_PAID = "partially_paid";
const FIN_REFUNDED = "refunded";
const FIN_PARTIALLY_REFUNDED = "partially_refunded";

// Valores normalizados de delivery_status (orders.delivery_status, cambio
// 0036, nullable). 'delivered' = entregado al cliente; 'in_progress' =
// seguimiento añadido / en tránsito, aún no entregado; null = sin señal de
// entrega. Derivado de los fulfillments en lib/shopify/delivery-status.ts.
const DELIVERY_DELIVERED = "delivered";
const DELIVERY_IN_PROGRESS = "in_progress";

/**
 * Subconjunto de la fila `orders` que el motor necesita para decidir.
 *
 * `fulfillment_status` (preparación) se conserva en el tipo por
 * compatibilidad de lectura, pero el motor YA NO lo usa para decidir las
 * etapas de envío/entrega (cambio 0036) — esas se rigen por `delivery_status`.
 */
export interface OrderStatusSnapshot {
  financial_status: string;
  fulfillment_status: string | null;
  delivery_status: string | null;
  cancelled_at: string | null;
}

/**
 * Decide la etapa destino a partir del estado del pedido. Función PURA:
 * lee solo el snapshot que recibe (en producción, la fila `orders` ya
 * persistida y reconciliada por LWW — así hereda la protección contra
 * estados tardíos/desordenados sin lógica de timestamps propia).
 */
export function evaluatePostventaTarget(order: OrderStatusSnapshot): PostventaTarget {
  const fin = (order.financial_status ?? "").trim().toLowerCase();
  const delivery = (order.delivery_status ?? "").trim().toLowerCase();

  // 1) Problema (one-way → Caso problemático). El pedido cancelado o
  //    reembolsado se revisa sin importar dónde esté la opp. Se evalúa
  //    ANTES que entrega/pago: un pedido reembolsado puede seguir marcado
  //    como entregado, pero el reembolso domina.
  if (order.cancelled_at) {
    return { kind: "problem", reason: "order_cancelled" };
  }
  if (fin === FIN_REFUNDED || fin === FIN_PARTIALLY_REFUNDED) {
    return { kind: "problem", reason: `financial_status:${fin}` };
  }

  // 2) Entrega tiene precedencia sobre pago (cambio 0036). El estado de
  //    entrega se deriva de los fulfillments (delivery_status normalizado).
  if (delivery === DELIVERY_DELIVERED) {
    return { kind: "advance", position: 4, reason: "delivery:delivered" };
  }
  if (delivery === DELIVERY_IN_PROGRESS) {
    return { kind: "advance", position: 3, reason: "delivery:in_progress" };
  }
  // null / "" → sin señal de entrega → cae a pago (no avanza a envío/entrega).

  // 3) Pago.
  if (fin === FIN_PAID) {
    return { kind: "advance", position: 2, reason: "financial:paid" };
  }
  if (fin === FIN_PENDING || fin === FIN_PARTIALLY_PAID) {
    // partially_paid se trata como pendiente (decisión M3v2).
    return { kind: "advance", position: 1, reason: `financial:${fin}` };
  }

  // 4) Estado inesperado (financial_status fuera del catálogo conocido y
  //    sin señal de entrega): la opp se queda donde está.
  return {
    kind: "none",
    reason: `unmapped financial:${fin || "∅"} delivery:${delivery || "∅"}`,
  };
}
