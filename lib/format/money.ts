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

const compactFormatters = new Map<string, Intl.NumberFormat>();

/**
 * Formato monetario COMPACTO para montos grandes en tarjetas/indicadores
 * (Mi Día, M1v2): `$1.2M`, `$45k`. Bajo $10,000 cae al formato completo
 * (un "$8,500" se lee mejor que "$8.5k"). Devuelve null para null/NaN.
 */
export function formatAmountCompact(
  amount: Numeric | number | null,
  currency: string,
): string | null {
  if (amount === null || amount === undefined) return null;
  const num = typeof amount === "string" ? Number(amount) : amount;
  if (Number.isNaN(num)) return null;
  if (Math.abs(num) < 10_000) return formatAmount(num, currency);
  const key = currency;
  let fmt = compactFormatters.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat("es-MX", {
        style: "currency",
        currency,
        notation: "compact",
        maximumFractionDigits: 1,
      });
      compactFormatters.set(key, fmt);
    } catch {
      return `${Math.round(num).toLocaleString("es-MX")} ${currency}`;
    }
  }
  return fmt.format(num);
}
