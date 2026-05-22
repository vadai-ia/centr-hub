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

/** Header HTTP con el identificador único de cada entrega (dedup). */
export const WHAAPY_EVENT_ID_HEADER = "x-webhook-id" as const;

/** Campo custom usado para marcar escrituras outbound (R11 capa A). */
export const WHAAPY_OUTBOUND_MARKER_FIELD = "last_platform_write_at" as const;
