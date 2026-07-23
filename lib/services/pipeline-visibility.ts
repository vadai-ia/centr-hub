import "server-only";
import { DateTime } from "luxon";
import {
  CLOSED_LIST_RETENTION_DAYS,
  DEFAULT_HIDE_CLOSED_AFTER_DAYS,
  DEFAULT_PIPELINE_MIN_DATE,
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
 * Instante de corte (UTC ISO) del PISO de visibilidad del pipeline. Lee
 * `organizations.config.pipeline.min_effective_date` ('YYYY-MM-DD') y lo
 * interpreta como inicio de día en CDMX (CLAUDE.md "Timezone"). Fallback al
 * default (`DEFAULT_PIPELINE_MIN_DATE`) si la clave falta o es inválida. El
 * piso se aplica SIEMPRE (no depende de filtros del usuario) en el data layer
 * del kanban — es visibility-only.
 */
export function readPipelineMinDateIso(config: Json | null | undefined): string {
  let raw: unknown;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const pipeline = (config as Record<string, unknown>).pipeline;
    if (pipeline && typeof pipeline === "object" && !Array.isArray(pipeline)) {
      raw = (pipeline as Record<string, unknown>).min_effective_date;
    }
  }
  const dateStr =
    typeof raw === "string" && raw.trim().length > 0
      ? raw.trim()
      : DEFAULT_PIPELINE_MIN_DATE;
  const dt = DateTime.fromISO(dateStr, { zone: TIMEZONE }).startOf("day");
  const valid = dt.isValid
    ? dt
    : DateTime.fromISO(DEFAULT_PIPELINE_MIN_DATE, { zone: TIMEZONE }).startOf("day");
  return valid.toUTC().toISO() ?? new Date(DEFAULT_PIPELINE_MIN_DATE).toISOString();
}

/**
 * Instante de corte de RETENCIÓN de la lista de cerradas (M4v2): una opp
 * archivada hace MÁS de `CLOSED_LIST_RETENTION_DAYS` (30) deja de
 * mostrarse en "Ver cerradas" / "Casos resueltos". Ventana móvil por
 * opp, anclada en America/Mexico_City. Solo visualización (la opp sigue
 * en la BD). Es el piso del bucket "revelable": [retención, auto-ocultar).
 */
export function computeClosedListRetentionCutoffIso(): string {
  return computeClosedCutoffIso(CLOSED_LIST_RETENTION_DAYS);
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
