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
