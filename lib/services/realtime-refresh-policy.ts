import {
  PIPELINE_POLLING_FALLBACK_MS,
  REALTIME_BURST_FULL_RELOAD_THRESHOLD,
  REALTIME_SAFETY_POLL_MS,
} from "@/lib/constants";

/**
 * Cuándo recargar de fondo un tablero con Realtime (Pipeline, Mi Día).
 * Módulo PURO: el estado entra como parámetro, sin relojes ni `document`.
 *
 * Por qué existe: el tablero se recargaba completo cada 30 s SIEMPRE, y con
 * pestañas abiertas todo el día eso agotó el CPU del plan de Vercel y pausó
 * el proyecto. La recarga de fondo era una red de seguridad que se pagaba
 * como si fuera el camino principal.
 *
 * Reglas:
 * - Pestaña OCULTA → nunca. Nadie la está viendo; se recarga al volver.
 * - Al VOLVER a la pestaña → si quedó algo pendiente mientras estaba oculta,
 *   o si pasó más de un periodo de respaldo desde la última recarga.
 * - Realtime CAÍDO → cada `PIPELINE_POLLING_FALLBACK_MS` (como antes).
 * - Realtime CONECTADO → cada `REALTIME_SAFETY_POLL_MS`. Los cambios ya
 *   llegan al instante por Realtime; esto solo cubre un evento perdido sin
 *   que la conexión lo reporte. NO se quita del todo: el polling fallback
 *   no se retira hasta validar Realtime empíricamente (CLAUDE.md, M5-DT-03).
 */
export interface RefreshState {
  hidden: boolean;
  connected: boolean;
  msSinceLastRefresh: number;
  /** Llegaron cambios mientras la pestaña estaba oculta y no se aplicaron. */
  dirty: boolean;
}

export type RefreshTrigger = "tick" | "visible";

export function shouldBackgroundRefresh(trigger: RefreshTrigger, s: RefreshState): boolean {
  if (s.hidden) return false;
  if (s.dirty) return true;
  if (trigger === "visible") return s.msSinceLastRefresh >= PIPELINE_POLLING_FALLBACK_MS;
  const period = s.connected ? REALTIME_SAFETY_POLL_MS : PIPELINE_POLLING_FALLBACK_MS;
  return s.msSinceLastRefresh >= period;
}

/**
 * Cómo aplicar una ráfaga de tarjetas cambiadas (Pipeline). Con pocas, leer
 * cada una es lo más barato y mantiene los toasts por tarjeta; con muchas
 * (un proceso horario que mueve decenas), UNA recarga completa cuesta menos
 * que N lecturas sueltas.
 */
export function planBurstFlush(pendingCount: number): "none" | "per_item" | "full_reload" {
  if (pendingCount <= 0) return "none";
  return pendingCount >= REALTIME_BURST_FULL_RELOAD_THRESHOLD ? "full_reload" : "per_item";
}
