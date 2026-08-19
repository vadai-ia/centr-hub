/**
 * Helpers de formato para el Dashboard (M8.2). Puros, sin
 * `server-only` ni dependencias de Supabase — usables desde Server y
 * Client Components y desde los generadores de export.
 *
 * Convención de "sin datos": rates/promedios llegan como `null` cuando
 * el denominador es 0 → se renderiza "—", nunca NaN.
 */

export const DASH = "—" as const;

const numberFmt = new Intl.NumberFormat("es-MX");

/** Conteo entero con separador de miles es-MX. */
export function formatCount(n: number): string {
  return numberFmt.format(Math.round(n));
}

/** Porcentaje (recibe una fracción 0..1). null → "—". */
export function formatPercent(fraction: number | null, decimals = 0): string {
  if (fraction === null || Number.isNaN(fraction)) return DASH;
  return `${(fraction * 100).toFixed(decimals)}%`;
}

/** Promedio de días (sales cycle). null → "—". */
export function formatDays(days: number | null): string {
  if (days === null || Number.isNaN(days)) return DASH;
  const rounded = Math.round(days * 10) / 10;
  return `${numberFmt.format(rounded)} días`;
}

/**
 * Fecha civil `YYYY-MM-DD` → "1 de mayo de 2026". Se formatea a mano
 * (sin `new Date()`) para que no dependa del huso del navegador: la
 * fecha ya viene resuelta en CDMX desde el servidor.
 */
const MONTHS_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
] as const;

export function formatCivilDate(isoDate: string | null): string {
  if (!isoDate) return DASH;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!m) return isoDate;
  const month = MONTHS_ES[Number(m[2]) - 1];
  if (!month) return isoDate;
  return `${Number(m[3])} de ${month} de ${m[1]}`;
}
