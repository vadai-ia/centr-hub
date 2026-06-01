import type { Numeric } from "@/lib/types/database";

/**
 * Helpers de formato monetario y elección de monto efectivo.
 *
 * Viven en `lib/format/` (no `lib/db/`) y NO importan `server-only`,
 * para que tanto Server Components como Client Components puedan
 * usarlos. La lógica es pura: ninguna dependencia de Supabase ni
 * de tenant context.
 */

/**
 * Devuelve el monto a mostrar y si proviene del estimado (manual,
 * pre-Draft Order) o del valor real (post-Draft Order).
 */
export function effectiveAmount(opp: {
  actual_amount: Numeric | null;
  estimated_amount: Numeric | null;
}): { value: Numeric | null; isEstimated: boolean } {
  if (opp.actual_amount !== null) {
    return { value: opp.actual_amount, isEstimated: false };
  }
  if (opp.estimated_amount !== null) {
    return { value: opp.estimated_amount, isEstimated: true };
  }
  return { value: null, isEstimated: false };
}

const currencyFormatters = new Map<string, Intl.NumberFormat>();

/**
 * Formatea un monto en es-MX con la moneda dada. Devuelve null si
 * el input es null o NaN. Para currency desconocida, fallback a
 * `<num> <CODE>`.
 */
export function formatAmount(
  amount: Numeric | number | null,
  currency: string,
): string | null {
  if (amount === null || amount === undefined) return null;
  const num = typeof amount === "string" ? Number(amount) : amount;
  if (Number.isNaN(num)) return null;
  let fmt = currencyFormatters.get(currency);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat("es-MX", { style: "currency", currency });
      currencyFormatters.set(currency, fmt);
    } catch {
      return `${num.toFixed(2)} ${currency}`;
    }
  }
  return fmt.format(num);
}
