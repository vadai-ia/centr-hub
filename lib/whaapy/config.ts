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
