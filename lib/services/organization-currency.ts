import { DEFAULT_CURRENCY } from "@/lib/constants";
import type { Json } from "@/lib/types/database";

/**
 * Moneda de la organización — `organizations.config.defaults.currency`.
 *
 * Por qué existe: `DEFAULT_CURRENCY` es la constante "MXN" del arranque, y
 * estaba cableada en el dashboard, el desglose por vendedor y la
 * exportación. Con una tienda que vende en COP (Centr Colombia: su Shopify
 * reporta `currencyCode: COP`), esos números salían etiquetados como pesos
 * mexicanos — el mismo importe leído como una moneda que no es, que es peor
 * que no mostrarlo.
 *
 * Los montos POR REGISTRO (pedido, oportunidad) ya guardan su propia
 * `currency` y no dependen de esto; lo que resuelve este lector son los
 * AGREGADOS (sumas del dashboard), donde no hay una fila de la cual heredarla.
 *
 * Fallback a MXN cuando la clave falta o no es un código ISO de 3 letras:
 * las orgs existentes no tienen que migrar nada para seguir igual.
 *
 * NO es `server-only`: función pura sobre un Json, y el valor resuelto viaja
 * al cliente (el dashboard formatea en el navegador).
 */
export function readOrganizationCurrency(
  config: Json | null | undefined,
): string {
  let raw: unknown;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const defaults = (config as Record<string, unknown>).defaults;
    if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
      raw = (defaults as Record<string, unknown>).currency;
    }
  }
  if (typeof raw !== "string") return DEFAULT_CURRENCY;
  const code = raw.trim().toUpperCase();
  // ISO 4217 son 3 letras. Un valor basura rompería `Intl.NumberFormat`, que
  // lanza y tumbaría la pantalla entera del dashboard.
  return /^[A-Z]{3}$/.test(code) ? code : DEFAULT_CURRENCY;
}
