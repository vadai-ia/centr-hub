import { DateTime } from "luxon";
import { PRESENCE_ONLINE_WINDOW_MINUTES } from "@/lib/constants";
import type { ISODateString } from "@/lib/types/database";

/**
 * Presentación de la presencia (0057) — módulo PURO.
 *
 * NO es `server-only`: la pantalla de Usuarios re-pide la presencia cada
 * tanto y vuelve a formatear en el navegador, así que las mismas reglas
 * tienen que correr en los dos lados. Si se duplicaran, el "en línea" del
 * primer render y el del refresco podrían discrepar.
 *
 * El "ahora" entra siempre como parámetro: una función que llama a
 * `DateTime.now()` por su cuenta no se puede probar, y el servidor y el
 * navegador no tienen el mismo reloj.
 */

/**
 * ¿Está usando la plataforma en este momento?
 *
 * La ventana es mayor que el intervalo del latido a propósito (ver
 * `PRESENCE_ONLINE_WINDOW_MINUTES`): con una ventana más corta la persona
 * parpadearía entre "en línea" y "desconectada" en cada hueco entre latidos.
 */
export function isOnline(
  lastSeenAt: ISODateString | null,
  nowISO: ISODateString,
  windowMinutes: number = PRESENCE_ONLINE_WINDOW_MINUTES,
): boolean {
  if (!lastSeenAt) return false;
  const last = DateTime.fromISO(lastSeenAt);
  const now = DateTime.fromISO(nowISO);
  if (!last.isValid || !now.isValid) return false;
  const minutes = now.diff(last, "minutes").minutes;
  // Un último latido en el futuro (reloj del cliente adelantado) cuenta como
  // en línea: es más honesto que decir "sin actividad" de alguien que acaba
  // de latir.
  return minutes <= windowMinutes;
}

/**
 * Texto de la columna "última vez". Responde la pregunta tal como se pidió
 * —"estuvo conectado sí o no"— y, cuando no está, cuándo fue la última vez.
 */
export function formatLastSeen(
  lastSeenAt: ISODateString | null,
  nowISO: ISODateString,
  zone: string,
): string {
  if (!lastSeenAt) return "Sin actividad";
  if (isOnline(lastSeenAt, nowISO)) return "En línea";
  const last = DateTime.fromISO(lastSeenAt, { zone });
  const now = DateTime.fromISO(nowISO, { zone });
  if (!last.isValid || !now.isValid) return "Sin actividad";

  const minutes = Math.floor(now.diff(last, "minutes").minutes);
  if (minutes < 60) return `hace ${Math.max(minutes, 1)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24 && last.hasSame(now, "day")) {
    return `hoy ${last.toFormat("HH:mm")}`;
  }
  if (last.hasSame(now.minus({ days: 1 }), "day")) {
    return `ayer ${last.toFormat("HH:mm")}`;
  }
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(now.startOf("day").diff(last.startOf("day"), "days").days);
  if (days < 7) return `hace ${days} d`;
  return last.setLocale("es-MX").toFormat("d LLL");
}

/** Un tramo ya formateado para el historial. */
export interface ActivitySessionView {
  id: string;
  /** "09:12" */
  from: string;
  /** "13:40" */
  to: string;
  /** "4 h 28 min" */
  duration: string;
  /** El tramo sigue abierto (último latido dentro de la ventana de en línea). */
  ongoing: boolean;
}

/** Los tramos de un mismo día, que es como se pidió ver el historial. */
export interface ActivityDayView {
  /** Clave estable para el `key` de React — fecha ISO del día. */
  key: string;
  /** "Hoy", "Ayer", "vie 3 oct". */
  label: string;
  sessions: ActivitySessionView[];
  /** Suma de los tramos del día: "5 h 10 min". */
  total: string;
}

export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return "menos de 1 min";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

function dayLabel(day: DateTime, now: DateTime): string {
  if (day.hasSame(now, "day")) return "Hoy";
  if (day.hasSame(now.minus({ days: 1 }), "day")) return "Ayer";
  const label = day.setLocale("es-MX").toFormat(
    day.hasSame(now, "year") ? "ccc d 'de' LLLL" : "ccc d 'de' LLLL yyyy",
  );
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Agrupa los tramos por día EN LA ZONA DE LA ORGANIZACIÓN. No es un detalle
 * cosmético: un tramo de las 23:40 se reporta en un día u otro según la zona,
 * y con una tienda en Bogotá el día del historial saldría corrido respecto a
 * lo que esa persona vivió.
 *
 * Un tramo que cruza la medianoche se reporta en el día en que EMPEZÓ — es
 * como lo cuenta quien trabajó ("me quedé hasta la 1").
 */
export function groupSessionsByDay(
  sessions: Array<{ id: string; startedAt: ISODateString; lastSeenAt: ISODateString }>,
  nowISO: ISODateString,
  zone: string,
): ActivityDayView[] {
  const now = DateTime.fromISO(nowISO, { zone });
  const byDay = new Map<string, { day: DateTime; items: ActivitySessionView[]; minutes: number }>();

  for (const s of sessions) {
    const from = DateTime.fromISO(s.startedAt, { zone });
    const to = DateTime.fromISO(s.lastSeenAt, { zone });
    if (!from.isValid || !to.isValid) continue;
    const key = from.toISODate() ?? "";
    const minutes = Math.max(to.diff(from, "minutes").minutes, 0);
    const bucket = byDay.get(key) ?? { day: from.startOf("day"), items: [], minutes: 0 };
    bucket.items.push({
      id: s.id,
      from: from.toFormat("HH:mm"),
      to: to.toFormat("HH:mm"),
      duration: formatDuration(minutes),
      ongoing: isOnline(s.lastSeenAt, nowISO),
    });
    bucket.minutes += minutes;
    byDay.set(key, bucket);
  }

  return Array.from(byDay.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, bucket]) => ({
      key,
      label: dayLabel(bucket.day, now),
      sessions: bucket.items,
      total: formatDuration(bucket.minutes),
    }));
}
