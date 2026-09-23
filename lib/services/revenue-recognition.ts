/**
 * Reconocimiento de ingresos por ANTICIPO (módulo PURO, sin acceso a BD).
 *
 * Centr cobra parte de la venta por adelantado y lo marca con una etiqueta de
 * Shopify: `Anticipo50%`, `Anticipo60%`, … Regla confirmada por la dirección:
 * **cada mitad se registra en su propio mes** — el anticipo en el mes en que
 * entró (cuando se procesó el pedido) y el resto en el mes en que el pedido se
 * finaliza (`settled_at`, migración 0055).
 *
 * El porcentaje sale del NOMBRE de la etiqueta, no de una configuración: crear
 * `Anticipo40%` en Shopify basta para que el sistema la respete. Evita que
 * agregar un porcentaje nuevo dependa de un deploy o de capturar nada.
 *
 * Un pedido sin etiqueta de anticipo se comporta como siempre: cuenta completo
 * en el mes en que se pagó.
 */

/** `Anticipo50%`, `anticipo 60 %`, `ANTICIPO70%` → 50 / 60 / 70. */
const ADVANCE_TAG = /^anticipo\s*(\d{1,3})\s*%$/;

/** Estados de Shopify en los que la venta puede reconocerse (total o parcial). */
const RECOGNIZABLE_STATUSES = new Set(["paid", "pending", "partially_paid"]);

export interface RecognizableOrder {
  /** Subtotal de Shopify: la venta se mide así (sin envío, con descuentos). */
  subtotal: string | number;
  /** `processed_at` de Shopify: cuándo se procesó el pedido (entra el anticipo). */
  paid_at: string | null;
  /** Cuándo quedó liquidado (0055). NULL = todavía no se finaliza. */
  settled_at: string | null;
  financial_status: string;
  cancelled_at?: string | null;
  shopify_tags: string[] | null;
}

/** Una porción de venta reconocida en una fecha concreta. */
export interface RecognitionSlice {
  amount: number;
  /** Fecha (UTC ISO) con la que la porción cae en un mes/periodo. */
  at: string;
}

/**
 * Porcentaje de anticipo declarado por las etiquetas del pedido, o null si no
 * hay ninguna. Con varias etiquetas de anticipo (no debería pasar) gana la
 * primera: inventar una suma sería peor que ser predecible.
 */
export function advancePercentFromTags(tags: string[] | null): number | null {
  for (const raw of tags ?? []) {
    const match = ADVANCE_TAG.exec(raw.trim().toLowerCase());
    if (!match) continue;
    const pct = Number(match[1]);
    // 0% o 100% no parten nada; fuera de rango es una etiqueta mal escrita.
    if (Number.isFinite(pct) && pct > 0 && pct < 100) return pct;
  }
  return null;
}

/**
 * Parte un pedido en las porciones de venta que reconoce, cada una con la
 * fecha que decide su mes. Devuelve vacío cuando el pedido no aporta venta:
 * cancelado, reembolsado/anulado, o pendiente sin anticipo declarado.
 */
export function recognitionSlices(order: RecognizableOrder): RecognitionSlice[] {
  if (order.cancelled_at) return []; // cancelado no es venta
  if (!RECOGNIZABLE_STATUSES.has(order.financial_status)) return [];

  const subtotal = Number(order.subtotal);
  if (!Number.isFinite(subtotal) || subtotal === 0) return [];

  const pct = advancePercentFromTags(order.shopify_tags);
  const isPaid = order.financial_status === "paid";

  if (pct === null) {
    // Sin etiqueta: la venta entra completa cuando el pedido está pagado.
    return isPaid && order.paid_at ? [{ amount: subtotal, at: order.paid_at }] : [];
  }

  const slices: RecognitionSlice[] = [];
  // 1) El anticipo entra cuando se procesó el pedido — incluso si el pedido
  //    sigue pendiente de pago, que es justo el caso que la dirección pidió
  //    que dejara de marcar cero.
  if (order.paid_at) {
    slices.push({ amount: (subtotal * pct) / 100, at: order.paid_at });
  }
  // 2) El resto entra el mes en que el pedido se finaliza.
  if (isPaid && order.settled_at) {
    slices.push({ amount: (subtotal * (100 - pct)) / 100, at: order.settled_at });
  }
  return slices;
}

/** Porciones que caen dentro del periodo (límites inclusivos, UTC ISO). */
export function recognitionSlicesInPeriod(
  order: RecognizableOrder,
  startUtc: string,
  endUtc: string,
): RecognitionSlice[] {
  return recognitionSlices(order).filter((s) => s.at >= startUtc && s.at <= endUtc);
}
