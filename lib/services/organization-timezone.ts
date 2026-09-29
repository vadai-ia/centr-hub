import { IANAZone } from "luxon";
import { TIMEZONE } from "@/lib/constants";
import type { Json } from "@/lib/types/database";

/**
 * Zona horaria de la organización — `organizations.config.defaults.timezone`.
 *
 * Por qué existe: `TIMEZONE` ("America/Mexico_City") decidía qué es "hoy" y
 * dónde corta cada mes para TODAS las tiendas. Con una en Bogotá (UTC-5,
 * una hora adelante de CDMX) las ventas de la primera hora del día 1 caían
 * en el mes anterior, y el "hoy" de Mi Día se cortaba una hora tarde.
 *
 * El default NO es un detalle: mientras una org no configure zona, obtiene
 * exactamente los mismos límites que antes. Agregar una tienda en otro huso
 * no puede mover ni un minuto los números de las que ya operan.
 *
 * Valida contra la base IANA de luxon: una zona inválida haría que cada
 * `DateTime` salga `invalid` y los periodos se resolverían a `null`/NaN —
 * el dashboard entero en blanco por un typo en la configuración.
 *
 * NO es `server-only`: función pura, y el valor resuelto viaja al cliente
 * (el selector de mes y el rango custom se calculan en el navegador).
 */
export function readOrganizationTimezone(
  config: Json | null | undefined,
): string {
  let raw: unknown;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const defaults = (config as Record<string, unknown>).defaults;
    if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
      raw = (defaults as Record<string, unknown>).timezone;
    }
  }
  if (typeof raw !== "string") return TIMEZONE;
  const zone = raw.trim();
  return IANAZone.isValidZone(zone) ? zone : TIMEZONE;
}
