/**
 * Normalización del estado de ENTREGA de un pedido de Shopify (cambio 0036).
 *
 * NÚCLEO PURO (sin efectos, sin BD): dado el conjunto de fulfillments de un
 * pedido, deriva el estado de entrega normalizado que persiste
 * `orders.delivery_status` y que el motor de Post-venta usa para mover
 * "Envío en curso" / "Entregado".
 *
 *   'delivered'   → hay fulfillment(s) entregado(s) y ninguno vivo pendiente
 *                   de entrega (Shopify "Entregado").
 *   'in_progress' → hay fulfillment con seguimiento generado y aún no
 *                   entregado (Shopify "Seguimiento añadido" / en tránsito /
 *                   entrega parcial).
 *   null          → no hay fulfillment con señal de entrega → sin estado de
 *                   entrega (la opp se queda en su etapa de PAGO).
 *
 * Por qué la señal es "tiene seguimiento y no está entregado" y NO un enum
 * específico: cuando el carrier (FedEx) aún no escanea, `shipment_status`
 * suele venir NULL aunque el seguimiento ya exista — eso es justo lo que
 * Shopify muestra como "Seguimiento añadido". Atarlo a un literal del enum
 * perdería ese estado; atarlo a "hay tracking y no entregado" lo captura y
 * es robusto si FedEx luego reporta in_transit/out_for_delivery.
 *
 * Funciona con AMBAS formas de la API: webhook/REST (`shipment_status` en
 * minúsculas, `tracking_number`) y GraphQL (`displayStatus` en MAYÚSCULAS,
 * `deliveredAt`, `trackingInfo`). Todo se compara en minúsculas.
 *
 * NO es `server-only`: función pura sobre tipos planos, testeable directo.
 */

export type DeliveryStatus = "delivered" | "in_progress";

/**
 * Snapshot mínimo de UN fulfillment que la normalización necesita. Cada
 * fuente (mapper de webhook, pull GraphQL) lo construye desde su shape.
 */
export interface DeliveryFulfillmentSnapshot {
  /** El fulfillment está cancelado/errado (status cancelled/error/failure). */
  cancelled?: boolean;
  /** displayStatus de GraphQL (DELIVERED, IN_TRANSIT, …). */
  displayStatus?: string | null;
  /** shipment_status de REST (delivered, in_transit, … o null). */
  shipmentStatus?: string | null;
  /** deliveredAt de GraphQL (presente ⇒ entregado). */
  deliveredAt?: string | null;
  /** Hay número de seguimiento asociado. */
  hasTracking?: boolean;
  /** Números de guía del fulfillment (para detectar registros duplicados). */
  trackingNumbers?: string[];
}

/** Guías de un fulfillment, normalizadas y sin vacíos. */
export function collectTrackingNumbers(
  values: Array<string | null | undefined>,
): string[] {
  return values.map((v) => norm(v)).filter((v) => v !== "");
}

const DELIVERED_TOKENS = new Set(["delivered"]);

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

type FulfillmentClass = "delivered" | "shipping" | "none";

/** Clasifica UN fulfillment vivo. */
function classify(f: DeliveryFulfillmentSnapshot): FulfillmentClass {
  if (f.cancelled) return "none";

  const display = norm(f.displayStatus);
  const shipment = norm(f.shipmentStatus);

  // Entregado: deliveredAt presente, o el estado dice delivered.
  if (f.deliveredAt) return "delivered";
  if (DELIVERED_TOKENS.has(display) || DELIVERED_TOKENS.has(shipment)) {
    return "delivered";
  }

  // En curso: hay seguimiento, o hay cualquier estado de envío no vacío
  // que no sea "delivered" (in_transit, confirmed, label_printed, etc.,
  // incluido el caso shipment_status NULL con tracking = "Seguimiento
  // añadido").
  if (f.hasTracking) return "shipping";
  if (display !== "" || shipment !== "") return "shipping";

  return "none";
}

/**
 * Deriva el estado de entrega normalizado del pedido a partir de sus
 * fulfillments. Reglas de agregación (multi-fulfillment / envíos parciales):
 *   - Si TODOS los fulfillments con señal están entregados ⇒ 'delivered'.
 *   - Si ALGUNO tiene señal de envío (entregado o en curso) pero no todos
 *     entregados ⇒ 'in_progress' (parcial cuenta como en curso).
 *   - Si ninguno tiene señal de entrega ⇒ null.
 *
 * Excepción — MISMA guía: un fulfillment en curso cuya guía coincide con la
 * de uno ya entregado cuenta como entregado. Shopify a veces registra el
 * mismo paquete dos veces (visto en Centr: F3 "Seguimiento añadido" y F4
 * "Entregado" con la misma guía de FedEx) y el carrier solo confirma uno;
 * sin esto la opp se queda para siempre en "Envío en curso" salvo que alguien
 * marque el duplicado a mano. Un parcial real lleva guías distintas y sigue
 * esperando.
 */
export function normalizeDeliveryStatus(
  fulfillments: DeliveryFulfillmentSnapshot[],
): DeliveryStatus | null {
  let anySignal = false;
  let anyNonDelivered = false;
  let anyDelivered = false;

  const classified = fulfillments.map((f) => ({ f, c: classify(f) }));
  const deliveredTracking = new Set(
    classified
      .filter((x) => x.c === "delivered")
      .flatMap((x) => collectTrackingNumbers(x.f.trackingNumbers ?? [])),
  );

  for (const { f, c } of classified) {
    if (c === "none") continue;
    anySignal = true;
    if (c === "delivered") anyDelivered = true;
    else if (
      collectTrackingNumbers(f.trackingNumbers ?? []).some((t) =>
        deliveredTracking.has(t),
      )
    ) {
      anyDelivered = true;
    } else anyNonDelivered = true;
  }

  if (!anySignal) return null;
  if (anyDelivered && !anyNonDelivered) return "delivered";
  return "in_progress";
}
