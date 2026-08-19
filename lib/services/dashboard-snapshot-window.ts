import { DateTime } from "luxon";
import { TIMEZONE } from "@/lib/constants";

/**
 * Ventana del SNAPSHOT de pipeline del dashboard — corte por antigüedad.
 *
 * Contexto: "Activas (con cotización)" y "Pipeline $ actual" salen de
 * `listLivePipelineSnapshot`, la ÚNICA query del dashboard sin filtro de
 * fecha. Es deliberado: así el número coincide con el kanban, que tampoco
 * filtra por fecha de creación (ver ERRORES.md "Activas y Pipeline $
 * mezclaban snapshot del ahora con actividad del periodo").
 *
 * En Centr eso hace que el snapshot arrastre cotizaciones de años
 * anteriores que nadie cerró, y "Sin asignar" domina el tablero con una
 * cifra que no representa nada operable. La organización puede acotar el
 * snapshot a lo creado DESDE una fecha:
 *
 *   organizations.config.dashboard.pipeline_snapshot_since = "2026-05-01"
 *
 * **El corte es SOLO del dashboard.** El kanban sigue mostrando todo, así
 * que las dos vistas divergen a propósito — decisión del operador. Por eso
 * `DashboardData` expone la fecha aplicada: la UI debe declararla, o el
 * lector interpreta un número recortado como si fuera el total.
 *
 * Sin la key configurada (default de toda org nueva) no hay corte y el
 * comportamiento es idéntico al previo.
 *
 * Módulo PURO: no toca BD ni sesión, para que el contrato sea testeable.
 */

/** Key dentro de `organizations.config`. */
export const SNAPSHOT_SINCE_CONFIG_PATH = ["dashboard", "pipeline_snapshot_since"] as const;

export interface PipelineSnapshotWindow {
  /** Fecha civil configurada (`YYYY-MM-DD`) o null si no hay corte. */
  sinceDate: string | null;
  /** Instante UTC del inicio de ese día en CDMX, listo para la query. */
  sinceUtc: string | null;
}

export const NO_SNAPSHOT_WINDOW: PipelineSnapshotWindow = { sinceDate: null, sinceUtc: null };

/**
 * Lee `config.dashboard.pipeline_snapshot_since` y lo traduce al instante
 * UTC del inicio de ese día en America/Mexico_City. Un valor ausente,
 * vacío o con formato inválido se ignora (sin corte) — nunca lanza: un
 * config mal escrito no debe tumbar el dashboard entero.
 */
export function resolvePipelineSnapshotWindow(
  config: unknown,
): PipelineSnapshotWindow {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return NO_SNAPSHOT_WINDOW;
  }
  const dashboard = (config as Record<string, unknown>).dashboard;
  if (!dashboard || typeof dashboard !== "object" || Array.isArray(dashboard)) {
    return NO_SNAPSHOT_WINDOW;
  }
  const raw = (dashboard as Record<string, unknown>).pipeline_snapshot_since;
  if (typeof raw !== "string") return NO_SNAPSHOT_WINDOW;
  const sinceDate = raw.trim();
  if (sinceDate.length === 0) return NO_SNAPSHOT_WINDOW;

  const dt = DateTime.fromISO(sinceDate, { zone: TIMEZONE }).startOf("day");
  if (!dt.isValid) return NO_SNAPSHOT_WINDOW;

  return { sinceDate: dt.toFormat("yyyy-MM-dd"), sinceUtc: dt.toUTC().toISO()! };
}
