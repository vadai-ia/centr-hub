import type { MiDiaBellItem } from "@/lib/services/mi-dia";

/**
 * Filtro por antigüedad del panel de avisos — módulo PURO.
 *
 * Para qué: con cien avisos acumulados, "¿qué llegó hoy?" no se puede
 * contestar leyendo la lista. El filtro acota lo que se MUESTRA; no descarta
 * ni atiende nada.
 */

export type NotificationAge = "today" | "7d" | "30d" | "all";

export const NOTIFICATION_AGE_OPTIONS: Array<{ value: NotificationAge; label: string }> = [
  { value: "today", label: "Hoy" },
  { value: "7d", label: "7 días" },
  { value: "30d", label: "30 días" },
  { value: "all", label: "Todos" },
];

/**
 * El default es "Todos" a propósito. Un pendiente es trabajo sin hacer: que
 * la pantalla lo esconda sola, por viejo, es como se pierde una tarea. Quien
 * quiera acotar, acota.
 */
export const NOTIFICATION_AGE_DEFAULT: NotificationAge = "all";

const DIAS: Record<Exclude<NotificationAge, "all" | "today">, number> = {
  "7d": 7,
  "30d": 30,
};

export function filterByAge<T extends Pick<MiDiaBellItem, "createdAt">>(
  items: T[],
  age: NotificationAge,
  now: Date = new Date(),
): T[] {
  if (age === "all") return items;
  if (age === "today") {
    // "Hoy" es el día civil, no "últimas 24 h": a las 9 de la mañana nadie
    // llama "de hoy" a algo de ayer por la tarde. Y es el día de QUIEN MIRA
    // la pantalla (zona del navegador), no el de la organización: este
    // filtro no calcula un dato de negocio, solo acota lo que se ve.
    const hoy = now.toDateString();
    return items.filter((i) => {
      const d = new Date(i.createdAt);
      return !Number.isNaN(d.getTime()) && d.toDateString() === hoy;
    });
  }
  const corte = now.getTime() - DIAS[age] * 24 * 60 * 60 * 1000;
  return items.filter((i) => {
    const d = new Date(i.createdAt);
    // Una fecha ilegible NO se oculta: esconder un pendiente por un dato
    // sucio es peor que mostrarlo de más.
    return Number.isNaN(d.getTime()) || d.getTime() >= corte;
  });
}
