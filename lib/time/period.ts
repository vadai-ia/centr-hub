import { DateTime } from "luxon";
import { TIMEZONE } from "@/lib/constants";

/**
 * Resolución de periodos para el Dashboard (M8.2).
 *
 * TODO límite de periodo se calcula en America/Mexico_City vía luxon
 * y se convierte a UTC ISO para las queries (las columnas timestamptz
 * de Supabase comparan en UTC). NUNCA usar `new Date()` crudo para
 * límites — bug conocido servidor UTC vs cliente MX (CLAUDE.md
 * "Timezone"). Este módulo es el primer cableado real de luxon en el
 * proyecto; la constante `TIMEZONE` dejó de estar huérfana.
 *
 * Semántica de los presets: "últimos N días" inclusivos del día de
 * hoy en MX. `today` = solo hoy. `7d` = hoy + los 6 días previos, etc.
 */

export const PERIOD_PRESETS = ["today", "7d", "30d", "90d"] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

/** Número de días que abarca cada preset (incluyendo hoy). */
const PRESET_DAYS: Record<PeriodPreset, number> = {
  today: 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export interface ResolvedPeriod {
  /** Lower bound inclusivo en UTC ISO (inicio del primer día en MX). */
  startUtc: string;
  /** Upper bound inclusivo en UTC ISO (fin del último día en MX). */
  endUtc: string;
  /** Fecha local (yyyy-MM-dd, MX) para el header del export y la UI. */
  startLabel: string;
  /** Fecha local (yyyy-MM-dd, MX) para el header del export y la UI. */
  endLabel: string;
}

function nowInTz(): DateTime {
  return DateTime.now().setZone(TIMEZONE);
}

function toResolved(start: DateTime, end: DateTime): ResolvedPeriod {
  return {
    startUtc: start.toUTC().toISO()!,
    endUtc: end.toUTC().toISO()!,
    startLabel: start.toFormat("yyyy-MM-dd"),
    endLabel: end.toFormat("yyyy-MM-dd"),
  };
}

/**
 * Resuelve un preset a límites UTC. El "hoy" se evalúa en MX, así que
 * un usuario que abre el dashboard a las 23:00 MX ve el día correcto
 * aunque el servidor esté en UTC (donde ya sería el día siguiente).
 */
export function resolvePresetPeriod(preset: PeriodPreset): ResolvedPeriod {
  const days = PRESET_DAYS[preset];
  const todayEnd = nowInTz().endOf("day");
  const start = nowInTz()
    .startOf("day")
    .minus({ days: days - 1 });
  return toResolved(start, todayEnd);
}

export interface CustomPeriodValid {
  ok: true;
  period: ResolvedPeriod;
}
export interface CustomPeriodInvalid {
  ok: false;
  reason: "invalid_format" | "from_after_to";
}
export type CustomPeriodResult = CustomPeriodValid | CustomPeriodInvalid;

/**
 * Resuelve un rango custom desde/hasta. Las entradas son fechas
 * locales en formato `yyyy-MM-dd` (lo que produce un `<input
 * type="date">`). El `from` se ancla al inicio del día en MX y el
 * `to` al fin del día en MX, de modo que el rango es inclusivo en
 * ambos extremos. Valida formato y `desde ≤ hasta`.
 */
export function resolveCustomPeriod(
  fromDate: string,
  toDate: string,
): CustomPeriodResult {
  const start = DateTime.fromISO(fromDate, { zone: TIMEZONE }).startOf("day");
  const end = DateTime.fromISO(toDate, { zone: TIMEZONE }).endOf("day");
  if (!start.isValid || !end.isValid) {
    return { ok: false, reason: "invalid_format" };
  }
  if (start > end) {
    return { ok: false, reason: "from_after_to" };
  }
  return { ok: true, period: toResolved(start, end) };
}

/**
 * Clave de mes (`yyyy-MM`) de un timestamp UTC, evaluada en MX. Usada
 * para bucketizar revenue por mes en las gráficas — un pago a las
 * 23:30 MX del 31-may cae en mayo, no en junio (que sería el bucket
 * si se usara UTC crudo).
 */
export function monthKeyInTz(utcIso: string): string {
  return DateTime.fromISO(utcIso, { zone: "utc" })
    .setZone(TIMEZONE)
    .toFormat("yyyy-MM");
}

/**
 * Lista ordenada de claves de mes (`yyyy-MM`) que cubre el periodo,
 * para que las gráficas muestren meses vacíos (revenue 0) en vez de
 * saltárselos. Tope defensivo de 36 meses para periodos custom muy
 * amplios — más allá la gráfica por mes deja de ser legible.
 */
export function monthKeysInPeriod(period: ResolvedPeriod): string[] {
  let cursor = DateTime.fromISO(period.startUtc, { zone: "utc" })
    .setZone(TIMEZONE)
    .startOf("month");
  const last = DateTime.fromISO(period.endUtc, { zone: "utc" })
    .setZone(TIMEZONE)
    .startOf("month");
  const keys: string[] = [];
  let guard = 0;
  while (cursor <= last && guard < 36) {
    keys.push(cursor.toFormat("yyyy-MM"));
    cursor = cursor.plus({ months: 1 });
    guard++;
  }
  return keys;
}

/**
 * Etiqueta legible del mes (`may 2026`) para el eje de las gráficas,
 * a partir de la clave `yyyy-MM`. En español, zona MX.
 */
export function monthLabel(monthKey: string): string {
  return DateTime.fromFormat(monthKey, "yyyy-MM", { zone: TIMEZONE })
    .setLocale("es")
    .toFormat("LLL yyyy");
}

/**
 * Días enteros entre dos timestamps (para sales cycle: creación →
 * won_at). Diferencia absoluta en días calendario aproximada por
 * división — suficiente para un promedio de "días a cierre".
 */
export function daysBetween(startUtc: string, endUtc: string): number {
  const start = DateTime.fromISO(startUtc, { zone: "utc" });
  const end = DateTime.fromISO(endUtc, { zone: "utc" });
  return end.diff(start, "days").days;
}

/**
 * Límites del "hoy" en zona MX, en UTC ISO. Mi Día (M1v2) clasifica
 * tareas/avisos en Atrasadas/Hoy según estos límites — NUNCA con
 * `new Date()` crudo del servidor (CLAUDE.md "Timezone").
 */
export function todayBoundsUtc(): { startUtc: string; endUtc: string } {
  const now = DateTime.now().setZone(TIMEZONE);
  return {
    startUtc: now.startOf("day").toUTC().toISO()!,
    endUtc: now.endOf("day").toUTC().toISO()!,
  };
}

/** Fin del día de HOY + 6 días (fin de "esta semana") en UTC ISO, zona MX. */
export function endOfWeekWindowUtc(): string {
  return DateTime.now()
    .setZone(TIMEZONE)
    .endOf("day")
    .plus({ days: 6 })
    .toUTC()
    .toISO()!;
}

/**
 * Reactivación de snooze a UTC ISO desde una opción rápida, calculada en
 * zona MX. "tomorrow" = mañana 09:00 MX (la reactivación real la dispara
 * el cron horario, así que una card "hasta mañana 9 AM" reaparece entre
 * 9:00 y 9:59 — aceptable y comunicado, CLAUDE.md). Cuida el borde
 * 23:55 → "mañana" es el día calendario siguiente en MX, no en UTC.
 */
export function snoozeUntilUtc(option: "1h" | "3h" | "tomorrow"): string {
  const now = DateTime.now().setZone(TIMEZONE);
  if (option === "1h") return now.plus({ hours: 1 }).toUTC().toISO()!;
  if (option === "3h") return now.plus({ hours: 3 }).toUTC().toISO()!;
  return now
    .plus({ days: 1 })
    .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!;
}

/** Clave de día (`yyyy-MM-dd`) de un timestamp UTC, evaluada en MX. */
export function dayKeyInTz(utcIso: string): string {
  return DateTime.fromISO(utcIso, { zone: "utc" })
    .setZone(TIMEZONE)
    .toFormat("yyyy-MM-dd");
}

/** Clave de día (`yyyy-MM-dd`) de HOY en MX. */
export function todayKeyInTz(): string {
  return DateTime.now().setZone(TIMEZONE).toFormat("yyyy-MM-dd");
}

/** Las últimas N claves de día (`yyyy-MM-dd`) en MX, de la más vieja a hoy. */
export function lastNDayKeys(n: number): string[] {
  const today = DateTime.now().setZone(TIMEZONE).startOf("day");
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    keys.push(today.minus({ days: i }).toFormat("yyyy-MM-dd"));
  }
  return keys;
}
