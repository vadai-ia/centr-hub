import "server-only";

/**
 * Configuración compartida del cliente Whaapy.
 *
 * El base URL se centraliza acá para que el cliente outbound, los
 * mappers y el script de setup usen exactamente el mismo endpoint.
 *
 * Marker que viaja en `custom_fields` de outbound writes — capa
 * adicional de defensa R11 sobre la opción B (timestamps). El
 * webhook resultante traerá `last_platform_write_at` en el GET de
 * reconciliación; si está presente y reciente, se descarta como eco.
 */

export const WHAAPY_API_BASE_URL = "https://api.whaapy.com" as const;
export const WHAAPY_API_VERSION = "v1" as const;

/** Endpoint base de la API contra el que viven las rutas de M4. */
export const WHAAPY_API_BASE = `${WHAAPY_API_BASE_URL}` as const;

/** Header HTTP con el HMAC firmado por Whaapy en cada webhook. */
export const WHAAPY_SIGNATURE_HEADER = "x-webhook-signature" as const;

/**
 * Header HTTP con el identificador único de cada entrega (dedup).
 *
 * IMPORTANTE: Whaapy reusa `x-webhook-id` por contact_id durante todo
 * el ciclo de vida del contact (created + updates + deleted comparten
 * el mismo valor). El identificador real por entrega es
 * `x-webhook-delivery-id` (prefijo `whd_*`). Ver entrada en ERRORES.md
 * "x-webhook-id de Whaapy es persistente por contact, no único por
 * delivery — dedup descartaba updates legítimos".
 *
 * Convención vs Shopify: `x-shopify-webhook-id` SÍ es único por
 * delivery, así que para Shopify ese es el campo correcto. NO asumir
 * que la convención de headers es portable entre proveedores.
 */
export const WHAAPY_DELIVERY_ID_HEADER = "x-webhook-delivery-id" as const;

/** Campo custom usado para marcar escrituras outbound (R11 capa A). */
export const WHAAPY_OUTBOUND_MARKER_FIELD = "last_platform_write_at" as const;

/**
 * Etapas del funnel del Whaapy de VENTA que la plataforma acciona.
 *
 * Match por nombre EXACTO contra `GET /funnel/v1/stages` (acentos y
 * mayúsculas cuentan), mismo contrato que `WHAAPY_POSTVENTA_STAGE_NAMES`.
 *
 * Por qué el funnel de VENTA y no el de Post-venta: el mensaje de
 * confirmación de entrega debe salir del NÚMERO DE VENTAS, el mismo con el
 * que el cliente cotizó. Las plantillas de WhatsApp pertenecen a la WABA de
 * cada instancia, así que el disparador tiene que vivir donde vive la
 * plantilla. El mensaje de seguimiento a 7 días sale del número de
 * Post-venta y usa el funnel de aquella instancia — están separados a
 * propósito.
 *
 * Hoy solo hay una: la plataforma no gestiona el funnel comercial de Whaapy
 * (ese lo operan los vendedores por conversación), solo empuja esta etapa
 * para disparar su Automation.
 */
export const WHAAPY_VENTA_STAGE_NAMES = {
  /** Confirmación de entrega — dispara el template ya aprobado en Venta. */
  entregado: "Entregado",
} as const;

export type WhaapyVentaStageKey = keyof typeof WHAAPY_VENTA_STAGE_NAMES;

/**
 * Kill switch de los push al funnel de VENTA (mensaje de entrega). Default
 * OFF, mismo patrón que `isPostventaWhaapySyncEnabled`: sin
 * `VENTA_DELIVERY_MESSAGE_ENABLED=true` no se mueve ningún contacto y el
 * deploy es inerte. Se lee de `process.env` directo para que togglear en
 * Vercel no requiera redeploy.
 */
export function isVentaDeliveryMessageEnabled(): boolean {
  return process.env.VENTA_DELIVERY_MESSAGE_ENABLED === "true";
}
