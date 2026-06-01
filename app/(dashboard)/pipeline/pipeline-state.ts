import type { KanbanOpportunity } from "@/lib/db/opportunities";
import type { PipelineStageRow, UUID } from "@/lib/types/database";

/**
 * Helpers de estado puros del kanban (M5).
 *
 * Vive aparte del componente principal para mantener `pipeline-board.tsx`
 * legible y bajo el umbral de 300 líneas. Son funciones puras —
 * fáciles de testear y razonar de manera aislada.
 */

export type CardsByStage = Record<UUID, KanbanOpportunity[]>;
export type HasMoreByStage = Record<UUID, boolean>;
export type PageByStage = Record<UUID, number>;

/**
 * Recorre las columnas y devuelve la stage que contiene la opp.
 * Usado por el handler de drag para resolver el origen sin requerir
 * que el card mande su stage_id (que podría desactualizarse).
 */
export function findStageContaining(
  cards: CardsByStage,
  stages: PipelineStageRow[],
  oppId: UUID,
): PipelineStageRow | null {
  for (const stage of stages) {
    if ((cards[stage.id] ?? []).some((o) => o.id === oppId)) return stage;
  }
  return null;
}

/**
 * Mover una card a otra columna (optimistic). El stage_id de la
 * card se actualiza in-place al ser insertada al destino para que
 * los próximos render usen el valor nuevo.
 */
export function moveCardLocal(
  cur: CardsByStage,
  card: KanbanOpportunity,
  fromStageId: UUID,
  toStageId: UUID,
): CardsByStage {
  return {
    ...cur,
    [fromStageId]: (cur[fromStageId] ?? []).filter((o) => o.id !== card.id),
    [toStageId]: [
      { ...card, stage_id: toStageId },
      ...(cur[toStageId] ?? []).filter((o) => o.id !== card.id),
    ],
  };
}

/**
 * Rollback de un movimiento optimista — quita la card del destino
 * fallido y la repone al origen con el snapshot pre-mutación
 * (incluye stage_id y last_modified_at originales).
 */
export function moveCardLocalRollback(
  cur: CardsByStage,
  card: KanbanOpportunity,
  failedDestId: UUID,
  originStageId: UUID,
): CardsByStage {
  return {
    ...cur,
    [failedDestId]: (cur[failedDestId] ?? []).filter((o) => o.id !== card.id),
    [originStageId]: [
      card,
      ...(cur[originStageId] ?? []).filter((o) => o.id !== card.id),
    ],
  };
}

/**
 * Elimina una opp de TODAS las columnas. Usado cuando Realtime emite
 * DELETE, o cuando la opp deja de matchear el filtro activo
 * (cambio de advisor, cancelación).
 */
export function removeOppById(cur: CardsByStage, oppId: UUID): CardsByStage {
  const next: CardsByStage = {};
  for (const [stageId, list] of Object.entries(cur)) {
    next[stageId] = list.filter((o) => o.id !== oppId);
  }
  return next;
}

/**
 * Reemplaza una opp existente con su versión refrescada y la coloca
 * en `toStageId` al inicio. Si estaba en otra columna, la quita
 * antes de insertarla.
 */
export function replaceOpp(
  cur: CardsByStage,
  opp: KanbanOpportunity,
  toStageId: UUID,
): CardsByStage {
  const cleaned = removeOppById(cur, opp.id);
  return {
    ...cleaned,
    [toStageId]: [opp, ...(cleaned[toStageId] ?? [])],
  };
}

/**
 * Upsert para Realtime: si la stage destino no está en el funnel
 * activo, la opp se va del board (caso: la opp cambió de funnel —
 * raro, pero pasa al canceler/restaurar manualmente).
 */
export function upsertOpp(
  cur: CardsByStage,
  opp: KanbanOpportunity,
  stagesById: Record<UUID, PipelineStageRow>,
): CardsByStage {
  if (!stagesById[opp.stage_id]) {
    return removeOppById(cur, opp.id);
  }
  return replaceOpp(cur, opp, opp.stage_id);
}

/**
 * Merge defensivo de paginación: agrega items nuevos al final
 * ignorando ids ya presentes (idempotencia ante refetch).
 */
export function mergePagedItems(
  existing: KanbanOpportunity[],
  incoming: KanbanOpportunity[],
): KanbanOpportunity[] {
  const seen = new Set(existing.map((o) => o.id));
  const merged = [...existing];
  for (const item of incoming) {
    if (!seen.has(item.id)) {
      merged.push(item);
      seen.add(item.id);
    }
  }
  return merged;
}

/**
 * Construye el estado inicial de `pageByStage` a partir de las
 * stages activas.
 */
export function initialPageByStage(stages: PipelineStageRow[]): PageByStage {
  const init: PageByStage = {};
  for (const s of stages) init[s.id] = 0;
  return init;
}
