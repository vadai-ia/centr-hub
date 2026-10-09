import type { Json } from "@/lib/types/database";

/**
 * País por defecto para interpretar teléfonos sin lada —
 * `organizations.config.defaults.phone_country` (ISO 3166-1 alfa-2).
 *
 * Por qué existe: al capturar un lead a mano, un número local ("310 456
 * 7890") no dice de qué país es. El sistema asumía SIEMPRE México, así que
 * en Centr Colombia los leads nacían con +52 — un teléfono que no existe y
 * al que nadie puede escribir. Lo reportaron en la junta.
 *
 * Solo aplica al número que se TECLEA sin lada. Un número que ya viene en
 * formato internacional (+57…) se respeta tal cual, venga de donde venga.
 *
 * Fallback a MX: las tiendas existentes no cambian de comportamiento.
 *
 * NO es `server-only`: función pura, también útil en el cliente para
 * pre-validar lo que el usuario escribe.
 */
export function readOrganizationPhoneCountry(
  config: Json | null | undefined,
): string {
  let raw: unknown;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const defaults = (config as Record<string, unknown>).defaults;
    if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
      raw = (defaults as Record<string, unknown>).phone_country;
    }
  }
  if (typeof raw !== "string") return "MX";
  const code = raw.trim().toUpperCase();
  // Dos letras: un valor basura haría que `parsePhoneNumberFromString`
  // ignore el país y devuelva null para CUALQUIER número local — todos los
  // leads empezarían a rechazarse por "teléfono inválido".
  return /^[A-Z]{2}$/.test(code) ? code : "MX";
}
