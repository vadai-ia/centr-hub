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
 *
 * ## Zona por ORGANIZACIÓN (multi-tienda)
 *
 * Cada función acepta `zone` como ÚLTIMO parámetro, con default
 * `TIMEZONE` (America/Mexico_City). El default no es pereza: es la garantía
 * de que agregar una tienda en otro huso NO mueve ni un minuto los cortes de
 * las que ya operan — quien no pasa zona obtiene el comportamiento anterior,
 * bit a bit.
 *
 * Quién SÍ debe pasarla: todo lo que corra en el contexto de una organización
 * concreta (acciones del dashboard, Mi Día, metas, y el cron de snapshot
 * mensual DENTRO de su bucle por org). La zona sale de
 * `readOrganizationTimezone(org.config)`.
 *
 * Por qué importa: entre Bogotá (UTC-5) y CDMX (UTC-6) hay una hora. Una venta
 * de las 00:30 del día 1 en Colombia cae en el mes ANTERIOR si se corta con la
 * zona de México — una hora de ventas mal atribuida en cada cierre de mes.
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

function nowInTz(zone: string = TIMEZONE): DateTime {
  return DateTime.now().setZone(zone);
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
export function resolvePresetPeriod(
  preset: PeriodPreset,
  zone: string = TIMEZONE,
): ResolvedPeriod {
  const days = PRESET_DAYS[preset];
  const todayEnd = nowInTz(zone).endOf("day");
  const start = nowInTz(zone)
    .startOf("day")
    .minus({ days: days - 1 });
  return toResolved(start, todayEnd);
}

/**
 * Periodo = MES EN CURSO en America/Mexico_City (M2v2 metas). Del 1° al
 * último día del mes; el avance de metas se reinicia el día 1 a las 00:00
 * MX. Independiente del filtro de periodo del Dashboard — las metas SIEMPRE
 * miden el mes corriente. Inclusivo en ambos extremos (mismos límites que
 * los presets, vía toResolved).
 */
export function resolveCurrentMonthPeriod(
  zone: string = TIMEZONE,
): ResolvedPeriod {
  const now = nowInTz(zone);
  return toResolved(now.startOf("month"), now.endOf("month"));
}

/** Clave del mes en curso (`yyyy-MM`) en MX. Para labels y period_month. */
export function currentMonthKey(zone: string = TIMEZONE): string {
  return nowInTz(zone).toFormat("yyyy-MM");
}

/** Los últimos `n` meses (`yyyy-MM`, MX), del en curso hacia atrás. */
export function recentMonthKeys(n: number, zone: string = TIMEZONE): string[] {
  const now = nowInTz(zone).startOf("month");
  return Array.from({ length: Math.max(0, n) }, (_, i) =>
    now.minus({ months: i }).toFormat("yyyy-MM"),
  );
}

export interface WeekSegment {
  /** Primer día (`yyyy-MM-dd`, MX). */
  from: string;
  /** Último día incluido (`yyyy-MM-dd`, MX). */
  to: string;
  /** Etiqueta corta, ej. "1–6 sept". */
  label: string;
}

/**
 * Semanas de un mes para la revisión semanal con el equipo, en MX.
 *
 * Semana = lunes a domingo, RECORTADA a los bordes del mes. Así la primera
 * semana de septiembre 2026 (el 1 cae en martes) es "1–6", no "31 ago–6 sep":
 * la meta se da por mes y la pregunta de cada lunes es cómo va ESE mes.
 *
 * En el mes en curso solo se devuelven las semanas que ya empezaron — una
 * semana futura daría un tablero en ceros indistinguible de un bug. "Hoy" se
 * resuelve en America/Mexico_City, no en el reloj del servidor.
 */
export function weeksOfMonth(
  monthKey: string,
  zone: string = TIMEZONE,
): WeekSegment[] {
  const month = DateTime.fromFormat(monthKey, "yyyy-MM", { zone });
  if (!month.isValid) return [];
  const monthEnd = month.endOf("month").startOf("day");
  const today = nowInTz(zone).startOf("day");
  const out: WeekSegment[] = [];
  let cursor = month.startOf("month");
  while (cursor <= monthEnd && cursor <= today) {
    // endOf("week") en luxon es la semana ISO: termina en domingo.
    const weekEnd = cursor.endOf("week").startOf("day");
    const to = weekEnd < monthEnd ? weekEnd : monthEnd;
    const monthName = to.setLocale("es").toFormat("LLL").replace(".", "");
    out.push({
      from: cursor.toFormat("yyyy-MM-dd"),
      to: to.toFormat("yyyy-MM-dd"),
      label:
        cursor.day === to.day ? `${to.day} ${monthName}` : `${cursor.day}–${to.day} ${monthName}`,
    });
    cursor = to.plus({ days: 1 });
  }
  return out;
}

/**
 * Opciones de mes/año para el selector del Dashboard, evaluadas en MX.
 * Devuelve los últimos `years` años (incluido el corriente) y, para el año
 * corriente, SOLO los meses ya iniciados: ofrecer un mes futuro produciría
 * un tablero en ceros indistinguible de un bug.
 *
 * Vive aquí y no en el componente porque "qué mes es hoy" debe resolverse en
 * America/Mexico_City como todo lo demás — con `new Date()` en el navegador,
 * alguien en otra zona vería un mes de más o de menos (CLAUDE.md "Timezone").
 */
export function monthSelectorOptions(
  years = 5,
  zone: string = TIMEZONE,
): {
  years: number[];
  currentYear: number;
  currentMonth: number;
} {
  const now = nowInTz(zone);
  const currentYear = now.year;
  return {
    years: Array.from({ length: years }, (_, i) => currentYear - i),
    currentYear,
    currentMonth: now.month,
  };
}

/**
 * Periodo del MES ANTERIOR en MX — el que acaba de cerrar. Lo usa el cron de
 * snapshot mensual (corre el día 1): al dispararse, "el mes pasado" es el
 * periodo a congelar. Maneja el cruce de año (1-ene → diciembre previo).
 */
export function resolvePreviousMonthPeriod(
  zone: string = TIMEZONE,
): ResolvedPeriod {
  const prev = nowInTz(zone).minus({ months: 1 });
  return toResolved(prev.startOf("month"), prev.endOf("month"));
}

/** Primer día (`yyyy-MM-dd`, MX) del mes anterior — valor de `period_month`. */
export function previousMonthDateKey(zone: string = TIMEZONE): string {
  return nowInTz(zone)
    .minus({ months: 1 })
    .startOf("month")
    .toFormat("yyyy-MM-dd");
}

/**
 * Periodo de un mes ARBITRARIO (`yyyy-MM`) en MX — del 1° al último día.
 * Para snapshots manuales/correctivos de un mes específico. `null` si la
 * clave no es válida.
 */
export function resolveMonthPeriod(
  monthKey: string,
  zone: string = TIMEZONE,
): ResolvedPeriod | null {
  const dt = DateTime.fromFormat(monthKey, "yyyy-MM", { zone });
  if (!dt.isValid) return null;
  return toResolved(dt.startOf("month"), dt.endOf("month"));
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
  zone: string = TIMEZONE,
): CustomPeriodResult {
  const start = DateTime.fromISO(fromDate, { zone }).startOf("day");
  const end = DateTime.fromISO(toDate, { zone }).endOf("day");
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
export function monthKeyInTz(utcIso: string, zone: string = TIMEZONE): string {
  return DateTime.fromISO(utcIso, { zone: "utc" })
    .setZone(zone)
    .toFormat("yyyy-MM");
}

/**
 * Lista ordenada de claves de mes (`yyyy-MM`) que cubre el periodo,
 * para que las gráficas muestren meses vacíos (revenue 0) en vez de
 * saltárselos. Tope defensivo de 36 meses para periodos custom muy
 * amplios — más allá la gráfica por mes deja de ser legible.
 */
export function monthKeysInPeriod(
  period: ResolvedPeriod,
  zone: string = TIMEZONE,
): string[] {
  let cursor = DateTime.fromISO(period.startUtc, { zone: "utc" })
    .setZone(zone)
    .startOf("month");
  const last = DateTime.fromISO(period.endUtc, { zone: "utc" })
    .setZone(zone)
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
export function monthLabel(monthKey: string, zone: string = TIMEZONE): string {
  return DateTime.fromFormat(monthKey, "yyyy-MM", { zone })
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
export function todayBoundsUtc(zone: string = TIMEZONE): {
  startUtc: string;
  endUtc: string;
} {
  const now = DateTime.now().setZone(zone);
  return {
    startUtc: now.startOf("day").toUTC().toISO()!,
    endUtc: now.endOf("day").toUTC().toISO()!,
  };
}

/** Fin del día de HOY + 6 días (fin de "esta semana") en UTC ISO, zona MX. */
export function endOfWeekWindowUtc(zone: string = TIMEZONE): string {
  return DateTime.now()
    .setZone(zone)
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
export function snoozeUntilUtc(
  option: "1h" | "3h" | "tomorrow",
  zone: string = TIMEZONE,
): string {
  const now = DateTime.now().setZone(zone);
  if (option === "1h") return now.plus({ hours: 1 }).toUTC().toISO()!;
  if (option === "3h") return now.plus({ hours: 3 }).toUTC().toISO()!;
  return now
    .plus({ days: 1 })
    .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!;
}

/** Clave de día (`yyyy-MM-dd`) de un timestamp UTC, evaluada en MX. */
export function dayKeyInTz(utcIso: string, zone: string = TIMEZONE): string {
  return DateTime.fromISO(utcIso, { zone: "utc" })
    .setZone(zone)
    .toFormat("yyyy-MM-dd");
}

/** Clave de día (`yyyy-MM-dd`) de HOY en MX. */
export function todayKeyInTz(zone: string = TIMEZONE): string {
  return DateTime.now().setZone(zone).toFormat("yyyy-MM-dd");
}

/** Las últimas N claves de día (`yyyy-MM-dd`) en MX, de la más vieja a hoy. */
export function lastNDayKeys(n: number, zone: string = TIMEZONE): string[] {
  const today = DateTime.now().setZone(zone).startOf("day");
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    keys.push(today.minus({ days: i }).toFormat("yyyy-MM-dd"));
  }
  return keys;
}
