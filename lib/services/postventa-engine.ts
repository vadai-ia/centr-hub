/**
 * Motor de transiciones automáticas de Post-venta — M3v2.
 *
 * NÚCLEO PURO (sin efectos, sin acceso a BD): dado el estado de pago y
 * preparación de un pedido de Shopify, decide a qué etapa del Funnel
 * Post-venta debe estar la oportunidad asociada.
 *
 * Mapeo confirmado por Centr (M3v2, respetar — no cambiar etapas):
 *
 *   | Etapa Post-venta      | Estado del pedido en Shopify        |
 *   |-----------------------|-------------------------------------|
 *   | Cotización completada | pago = pendiente                    |
 *   | Pago confirmado       | pago = pagado                       |
 *   | Envío en curso        | preparación = en curso (partial)    |
 *   | Entregado             | preparación = completa (fulfilled)  |
 *
 * Precedencia (decidida en el diagnóstico): la **preparación tiene
 * precedencia sobre el pago**. Pago y preparación coexisten (un pedido
 * pagado sigue pagado mientras se prepara y entrega). Por eso se evalúa
 * primero la preparación; solo si NO hay actividad de preparación se cae
 * al estado de pago.
 *
 * Cancelado / reembolsado (decisión M3v2): los tres estados problema
 * (`cancelled`, `refunded`, `partially_refunded`) mandan la opp a "Caso
 * problemático" para revisión humana — el motor entra a esa etapa pero
 * NUNCA saca de ahí (one-way; el cierre lo hace una persona).
 *
 * Pago parcial (decisión M3v2): `partially_paid` (ej. "Anticipo 50%") se
 * trata como PENDIENTE — la opp se queda en "Cotización completada" hasta
 * que el pago esté completo (`paid`). "Pago confirmado" = pagado 100%.
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

// Valores de fulfillment_status de Shopify (orders.fulfillment_status,
// nullable). "en curso" = partial (algunos ítems enviados); "completa" =
// fulfilled (todos enviados). unfulfilled/null = sin actividad de preparación.
const FUL_FULFILLED = "fulfilled";
const FUL_PARTIAL = "partial";

/** Subconjunto de la fila `orders` que el motor necesita para decidir. */
export interface OrderStatusSnapshot {
  financial_status: string;
  fulfillment_status: string | null;
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
  const ful = (order.fulfillment_status ?? "").trim().toLowerCase();

  // 1) Problema (one-way → Caso problemático). El pedido cancelado o
  //    reembolsado se revisa sin importar dónde esté la opp. Se evalúa
  //    ANTES que pago/preparación: un pedido reembolsado puede seguir
  //    marcado fulfilled, pero el reembolso domina.
  if (order.cancelled_at) {
    return { kind: "problem", reason: "order_cancelled" };
  }
  if (fin === FIN_REFUNDED || fin === FIN_PARTIALLY_REFUNDED) {
    return { kind: "problem", reason: `financial_status:${fin}` };
  }

  // 2) Preparación tiene precedencia sobre pago.
  if (ful === FUL_FULFILLED) {
    return { kind: "advance", position: 4, reason: "fulfillment:fulfilled" };
  }
  if (ful === FUL_PARTIAL) {
    return { kind: "advance", position: 3, reason: "fulfillment:partial" };
  }
  // unfulfilled / null / "" → sin actividad de preparación → cae a pago.

  // 3) Pago.
  if (fin === FIN_PAID) {
    return { kind: "advance", position: 2, reason: "financial:paid" };
  }
  if (fin === FIN_PENDING || fin === FIN_PARTIALLY_PAID) {
    // partially_paid se trata como pendiente (decisión M3v2).
    return { kind: "advance", position: 1, reason: `financial:${fin}` };
  }

  // 4) Estado inesperado (financial_status fuera del catálogo conocido y
  //    sin actividad de preparación): la opp se queda donde está.
  return {
    kind: "none",
    reason: `unmapped financial:${fin || "∅"} fulfillment:${ful || "∅"}`,
  };
}
