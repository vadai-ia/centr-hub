import type { KanbanOpportunity } from "@/lib/db/opportunities";
import type { Funnel, PipelineStageRow, UUID } from "@/lib/types/database";

/**
 * Tipos compartidos del pipeline (M5) entre server actions y UI.
 * Vive aquí porque los archivos `"use server"` solo pueden exportar
 * funciones — los tipos compartidos deben venir de otro módulo.
 */

export type MoveStageActionResult =
  | { ok: true; opportunity: KanbanOpportunity }
  | { ok: false; reason: string; message: string };

export type LoadPageActionResult =
  | { ok: true; items: KanbanOpportunity[]; hasMore: boolean }
  | { ok: false; reason: string; message: string };

export type FetchOppActionResult =
  | { ok: true; opportunity: KanbanOpportunity | null }
  | { ok: false; reason: string; message: string };

export interface PipelineInitialState {
  funnel: Funnel;
  stages: PipelineStageRow[];
  cardsByStage: Record<UUID, KanbanOpportunity[]>;
  hasMoreByStage: Record<UUID, boolean>;
  /** Conteo exacto por etapa (lote polish M6). Reemplaza al "50+"
   *  derivado de cards.length + hasMore. Para etapas cerradas es el
   *  conteo VISIBLE (excluye las auto-ocultas). */
  countsByStage: Record<UUID, number>;
  /** Conteo de cerradas OCULTAS por etapa (Fix de pipeline P1). Solo
   *  etapas Ganada/Perdida con opps fuera de la ventana. Alimenta el
   *  botón "Ver cerradas (N)". 0/ausente para etapas activas. */
  hiddenClosedByStage: Record<UUID, number>;
  /** Umbral global vigente (días) para el auto-ocultar — pinta el
   *  control admin del pipeline. */
  hideClosedAfterDays: number;
  /** Conteo de tareas pendientes por opportunity_id (lote polish M6). */
  pendingTasksByOpp: Record<UUID, number>;
  effectiveAdvisorId: UUID | null | undefined;
  advisors: AdvisorOption[];
  lossReasons: LossReasonOption[];
}

/**
 * Subset de membership + profile que pinta la card del kanban en
 * vista admin (asesor asignado).
 */
export interface AdvisorOption {
  membershipId: UUID;
  userId: UUID;
  fullName: string;
  color: string;
}

export interface LossReasonOption {
  id: UUID;
  name: string;
}
