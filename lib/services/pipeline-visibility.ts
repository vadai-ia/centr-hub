import "server-only";
import { DateTime } from "luxon";
import {
  DEFAULT_HIDE_CLOSED_AFTER_DAYS,
  HIDE_CLOSED_DAYS_MAX,
  HIDE_CLOSED_DAYS_MIN,
  TIMEZONE,
} from "@/lib/constants";
import type { Json, PipelineStageRow, UUID } from "@/lib/types/database";

/**
 * Auto-ocultar oportunidades cerradas del kanban (anti-ruido — Fix de
 * pipeline, Parte 1).
 *
 * Una opp en etapa Ganada (`is_won`) o Perdida (`is_lost`) se oculta del
 * kanban cuando pasaron MÁS de N días desde su cierre (`won_at` /
 * `lost_at`). N es el umbral global de la org (default 7), editable por
 * el admin. Es SOLO visualización del kanban: el dato vive intacto en su
 * etapa, no se cancela, no se mueve, y los KPIs del dashboard lo siguen
 * contando (usan sus propias queries, no este filtro).
 *
 * El filtro se materializa en el data layer: para una etapa cerrada se
 * pasa un `ClosedFilter` a `listKanbanOpportunities`, que mantiene
 * visibles solo las opps con la fecha de cierre dentro de la ventana
 * (o con fecha NULL — ver `pickClosedColumn`).
 */

/** Columna de fecha de cierre según el tipo de etapa cerrada. */
export type ClosedColumn = "won_at" | "lost_at";

export interface ClosedFilter {
  column: ClosedColumn;
  /** ISO UTC: solo se muestran cerradas con `column >= sinceIso` (o NULL). */
  sinceIso: string;
}

/**
 * Lee el umbral configurado en `organizations.config.pipeline.
 * hide_closed_after_days`. Fallback a 7 si la clave falta o es inválida.
 * Saneado a [0, 365] — 0 = ocultar apenas se cierra.
 */
export function readHideClosedDays(config: Json | null | undefined): number {
  let raw: unknown;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const pipeline = (config as Record<string, unknown>).pipeline;
    if (pipeline && typeof pipeline === "object" && !Array.isArray(pipeline)) {
      raw = (pipeline as Record<string, unknown>).hide_closed_after_days;
    }
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_HIDE_CLOSED_AFTER_DAYS;
  const clamped = Math.min(HIDE_CLOSED_DAYS_MAX, Math.max(HIDE_CLOSED_DAYS_MIN, Math.floor(n)));
  return clamped;
}

/** Saneado del valor que el admin captura antes de persistir. */
export function sanitizeHideClosedDays(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HIDE_CLOSED_AFTER_DAYS;
  return Math.min(HIDE_CLOSED_DAYS_MAX, Math.max(HIDE_CLOSED_DAYS_MIN, Math.floor(value)));
}

/**
 * Instante de corte (UTC ISO): una opp cerrada ANTES de este instante
 * se oculta. "Más de N días desde el cierre" → corte = ahora − N días,
 * anclado en America/Mexico_City (CLAUDE.md "Timezone").
 */
export function computeClosedCutoffIso(days: number): string {
  const cutoff = DateTime.now().setZone(TIMEZONE).minus({ days });
  return cutoff.toUTC().toISO() ?? new Date().toISOString();
}

/**
 * Devuelve el `ClosedFilter` para una etapa cerrada, o null si la etapa
 * NO es cerrada (las activas nunca se ocultan). El caller pasa el corte
 * ya calculado una sola vez por carga.
 */
export function closedFilterForStage(
  stage: Pick<PipelineStageRow, "is_won" | "is_lost">,
  cutoffIso: string,
): ClosedFilter | null {
  if (stage.is_won) return { column: "won_at", sinceIso: cutoffIso };
  if (stage.is_lost) return { column: "lost_at", sinceIso: cutoffIso };
  return null;
}

/**
 * Particiona las etapas en los sets que el conteo necesita para
 * bucketear visible/oculta por etapa cerrada.
 */
export function partitionClosedStages(
  stages: Pick<PipelineStageRow, "id" | "is_won" | "is_lost">[],
): { wonStageIds: UUID[]; lostStageIds: UUID[] } {
  const wonStageIds: UUID[] = [];
  const lostStageIds: UUID[] = [];
  for (const s of stages) {
    if (s.is_won) wonStageIds.push(s.id);
    else if (s.is_lost) lostStageIds.push(s.id);
  }
  return { wonStageIds, lostStageIds };
}
