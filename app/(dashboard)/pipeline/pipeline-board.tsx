"use client";
import { useCallback, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  fetchKanbanOpportunityAction,
  loadInitialPipelineState,
  loadKanbanPageAction,
  moveStageAction,
} from "@/lib/actions/pipeline";
import type { KanbanOpportunity } from "@/lib/db/opportunities";
import type {
  PipelineInitialState,
} from "@/lib/types/pipeline";
import type {
  Funnel,
  PipelineStageRow,
  Role,
  UUID,
} from "@/lib/types/database";
import { KanbanCard } from "./kanban-card";
import { KanbanColumn } from "./kanban-column";
import { LossReasonModal } from "./loss-reason-modal";
import { PipelineToolbar } from "./pipeline-toolbar";
import { PipelineToastStack } from "./pipeline-toast";
import { useToastStack } from "./use-toast-stack";
import { QuickView } from "./quick-view";
import { usePipelineRealtime, type RealtimeStatus } from "./use-pipeline-realtime";
import {
  findStageContaining,
  initialPageByStage,
  mergePagedItems,
  moveCardLocal,
  moveCardLocalRollback,
  removeOppById,
  replaceOpp,
  upsertOpp,
  type CardsByStage,
  type HasMoreByStage,
  type PageByStage,
} from "./pipeline-state";

interface Props {
  initial: PipelineInitialState;
  role: Role;
  userId: UUID;
  organizationId: UUID;
  unassignedFilter: boolean;
}

interface PendingLoss {
  opp: KanbanOpportunity;
  fromStage: PipelineStageRow;
  toStage: PipelineStageRow;
}

/**
 * Cliente principal del pipeline kanban (M5).
 *
 * Funciones (ver checklist del prompt M5):
 *   - Holding state de cards por etapa + has-more + page index.
 *   - Drag-and-drop con optimistic UI + rollback en error/stale.
 *   - Quick-view popup + modal de motivo de pérdida.
 *   - Toggle Venta/Post-venta con re-fetch del estado inicial.
 *   - Filtro admin "Sin asignar".
 *   - Real-time selectivo + polling fallback (hook).
 *   - Toast solo para acciones manuales.
 */
export function PipelineBoard({
  initial,
  role,
  userId,
  organizationId,
  unassignedFilter: initialUnassigned,
}: Props) {
  void userId;
  const isAdmin = role === "admin" || role === "superadmin";

  const [funnel, setFunnel] = useState<Funnel>(initial.funnel);
  const [unassignedFilter, setUnassignedFilter] = useState<boolean>(
    isAdmin && initialUnassigned,
  );
  const [stages, setStages] = useState<PipelineStageRow[]>(initial.stages);
  const [cardsByStage, setCardsByStage] = useState<CardsByStage>(
    initial.cardsByStage,
  );
  const [hasMoreByStage, setHasMoreByStage] = useState<HasMoreByStage>(
    initial.hasMoreByStage,
  );
  const [pageByStage, setPageByStage] = useState<PageByStage>(() =>
    initialPageByStage(initial.stages),
  );

  const [advisors] = useState(initial.advisors);
  const [lossReasons] = useState(initial.lossReasons);
  const [effectiveAdvisorId, setEffectiveAdvisorId] = useState<
    UUID | null | undefined
  >(initial.effectiveAdvisorId);

  const [activeDragId, setActiveDragId] = useState<UUID | null>(null);
  const [quickViewId, setQuickViewId] = useState<UUID | null>(null);
  const [pendingLoss, setPendingLoss] = useState<PendingLoss | null>(null);
  const [pendingMoves, setPendingMoves] = useState<Set<UUID>>(new Set());
  const { toasts, push: pushToast, dismiss: dismissToast } = useToastStack();

  // Stages indexados por id — útil para hot lookups en drag/realtime.
  const stagesById = useMemo(() => {
    const map: Record<UUID, PipelineStageRow> = {};
    for (const s of stages) map[s.id] = s;
    return map;
  }, [stages]);

  // Quick-view sin fetch — busca la card ya cargada en estado.
  const quickViewOpp = useMemo(() => {
    if (!quickViewId) return null;
    for (const list of Object.values(cardsByStage)) {
      const found = list.find((o) => o.id === quickViewId);
      if (found) return found;
    }
    return null;
  }, [cardsByStage, quickViewId]);

  const quickViewStage = quickViewOpp
    ? stagesById[quickViewOpp.stage_id] ?? null
    : null;

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 6 },
    }),
  );

  // ----- Realtime: refresca una opp via fetch action -----
  const refreshOpportunity = useCallback(
    async (oppId: UUID) => {
      const res = await fetchKanbanOpportunityAction({ opportunityId: oppId });
      if (!res.ok) return;
      if (!res.opportunity) {
        // Borrada o ya no visible → la sacamos de cualquier columna.
        setCardsByStage((cur) => removeOppById(cur, oppId));
        return;
      }
      const opp = res.opportunity;
      // Si la opp dejó de matchear el filtro de advisor del usuario,
      // la quitamos silenciosamente del tablero.
      if (effectiveAdvisorId === null && opp.assigned_advisor_id !== null) {
        setCardsByStage((cur) => removeOppById(cur, oppId));
        return;
      }
      if (
        effectiveAdvisorId !== undefined &&
        effectiveAdvisorId !== null &&
        opp.assigned_advisor_id !== effectiveAdvisorId
      ) {
        setCardsByStage((cur) => removeOppById(cur, oppId));
        return;
      }
      setCardsByStage((cur) => upsertOpp(cur, opp, stagesById));
    },
    [effectiveAdvisorId, stagesById],
  );

  // Aplica un PipelineInitialState al estado local — usado por
  // toggle de funnel, toggle "Sin asignar", y polling fallback.
  // El advisor se respeta o se actualiza según el resp del server
  // (puede haber cambiado por filtro admin).
  const applyState = useCallback(
    (state: PipelineInitialState, updateAdvisor: boolean) => {
      setStages(state.stages);
      setCardsByStage(state.cardsByStage);
      setHasMoreByStage(state.hasMoreByStage);
      setPageByStage(() => initialPageByStage(state.stages));
      if (updateAdvisor) setEffectiveAdvisorId(state.effectiveAdvisorId);
    },
    [],
  );

  const handlePollingTick = useCallback(async () => {
    const res = await loadInitialPipelineState({
      funnel,
      unassignedFilter: isAdmin && unassignedFilter,
    });
    if (res.ok) applyState(res.state, false);
  }, [applyState, funnel, isAdmin, unassignedFilter]);

  const realtimeStatus: RealtimeStatus = usePipelineRealtime({
    organizationId,
    funnel,
    effectiveAdvisorId,
    onEvent: (payload) => {
      const id = ((payload.new ?? payload.old) as { id?: UUID })?.id;
      if (!id) return;
      if (payload.eventType === "DELETE") {
        setCardsByStage((cur) => removeOppById(cur, id));
        return;
      }
      void refreshOpportunity(id);
    },
    onPollingTick: handlePollingTick,
  });

  // Toggle funnel + toggle "Sin asignar" — vuelven a cargar
  // el estado completo (stages, cards, paginación) y actualizan el
  // advisor efectivo según el resp del server.
  async function changeFunnel(next: Funnel) {
    if (next === funnel) return;
    setFunnel(next);
    const res = await loadInitialPipelineState({
      funnel: next,
      unassignedFilter: isAdmin && unassignedFilter,
    });
    if (res.ok) applyState(res.state, true);
  }

  async function changeUnassignedFilter(next: boolean) {
    setUnassignedFilter(next);
    const res = await loadInitialPipelineState({
      funnel,
      unassignedFilter: isAdmin && next,
    });
    if (res.ok) applyState(res.state, true);
  }

  // ----- Paginación por columna -----
  async function loadMoreForStage(stage: PipelineStageRow, page: number) {
    const res = await loadKanbanPageAction({
      funnel,
      stageId: stage.id,
      page,
      assignedAdvisorId: effectiveAdvisorId,
    });
    if (!res.ok) {
      pushToast(res.message, "error");
      return res;
    }
    setCardsByStage((cur) => ({
      ...cur,
      [stage.id]: mergePagedItems(cur[stage.id] ?? [], res.items),
    }));
    setHasMoreByStage((cur) => ({ ...cur, [stage.id]: res.hasMore }));
    setPageByStage((cur) => ({ ...cur, [stage.id]: page }));
    return res;
  }

  // ----- Drag-and-drop -----
  function onDragStart(e: DragStartEvent) {
    setActiveDragId(e.active.id as UUID);
  }
  async function onDragEnd(e: DragEndEvent) {
    setActiveDragId(null);
    const oppId = e.active.id as UUID;
    const toStageId = e.over?.id as UUID | undefined;
    if (!toStageId) return;

    const fromStage = findStageContaining(cardsByStage, stages, oppId);
    if (!fromStage) return;
    if (toStageId === fromStage.id) return;
    const toStage = stagesById[toStageId];
    if (!toStage) return;
    if (toStage.funnel !== fromStage.funnel) {
      pushToast(
        "No se puede mover entre Funnel Venta y Funnel Post-venta.",
        "error",
      );
      return;
    }
    const card = (cardsByStage[fromStage.id] ?? []).find((o) => o.id === oppId);
    if (!card) return;

    if (toStage.requires_loss_reason) {
      setPendingLoss({ opp: card, fromStage, toStage });
      return;
    }

    await commitMove(card, fromStage, toStage, null, null);
  }

  async function commitMove(
    card: KanbanOpportunity,
    fromStage: PipelineStageRow,
    toStage: PipelineStageRow,
    lossReasonId: UUID | null,
    note: string | null,
  ) {
    if (pendingMoves.has(card.id)) return;
    setPendingMoves((s) => new Set(s).add(card.id));

    const snapshot = card;
    // Optimistic: mover la card al destino en estado local.
    setCardsByStage((cur) =>
      moveCardLocal(cur, card, fromStage.id, toStage.id),
    );

    const res = await moveStageAction({
      opportunityId: card.id,
      toStageId: toStage.id,
      expectedLastModifiedAt: card.last_modified_at,
      lossReasonId,
      note,
    });

    setPendingMoves((s) => {
      const next = new Set(s);
      next.delete(card.id);
      return next;
    });

    if (!res.ok) {
      // Rollback: si fue stale, refrescamos via fetch para tomar el
      // último estado. Si no, devolvemos la card al estado snapshot.
      if (res.reason === "stale_version") {
        await refreshOpportunity(card.id);
        pushToast(
          "Esta oportunidad fue actualizada por otro usuario; recargando datos.",
          "info",
        );
      } else {
        setCardsByStage((cur) =>
          moveCardLocalRollback(cur, snapshot, toStage.id, fromStage.id),
        );
        pushToast(res.message, "error");
      }
      return;
    }

    // Reemplaza la card en estado con la versión refrescada del server
    // (trae nuevo last_modified_at, won_at, loss_reason_id, etc.).
    setCardsByStage((cur) =>
      replaceOpp(cur, res.opportunity, toStage.id),
    );

    if (toStage.is_won) {
      pushToast("Oportunidad marcada como ganada", "success");
    } else if (toStage.is_lost) {
      pushToast(`Movida a ${toStage.name}`, "success");
    } else {
      pushToast(`Movida a ${toStage.name}`, "success");
    }
  }

  function cancelLoss() {
    setPendingLoss(null);
  }

  async function confirmLoss(reasonId: string, note: string | null) {
    if (!pendingLoss) return;
    const { opp, fromStage, toStage } = pendingLoss;
    setPendingLoss(null);
    await commitMove(opp, fromStage, toStage, reasonId, note);
  }

  const activeDragCard = useMemo(() => {
    if (!activeDragId) return null;
    for (const list of Object.values(cardsByStage)) {
      const found = list.find((o) => o.id === activeDragId);
      if (found) return found;
    }
    return null;
  }, [activeDragId, cardsByStage]);

  if (stages.length === 0) {
    return (
      <div className="text-center py-16 text-gray-500 dark:text-gray-400">
        <p className="text-lg">No hay etapas activas en este funnel.</p>
        <p className="text-sm mt-2">
          Pídele al administrador que active al menos una etapa desde
          Administración → Etapas del pipeline.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PipelineToolbar
        funnel={funnel}
        role={role}
        unassignedFilter={isAdmin && unassignedFilter}
        realtimeStatus={realtimeStatus}
        onFunnelChange={changeFunnel}
        onUnassignedToggle={changeUnassignedFilter}
      />

      <DndContext
        sensors={dndSensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="flex-1 overflow-x-auto">
          <div className="flex gap-3 pb-2 min-w-min">
            {stages.map((stage) => (
              <KanbanColumn
                key={stage.id}
                stage={stage}
                cards={cardsByStage[stage.id] ?? []}
                hasMore={hasMoreByStage[stage.id] ?? false}
                advisors={advisors}
                showAdvisor={isAdmin}
                page={pageByStage[stage.id] ?? 0}
                onOpenQuickView={setQuickViewId}
                onLoadMore={loadMoreForStage}
              />
            ))}
          </div>
        </div>

        <DragOverlay>
          {activeDragCard ? (
            <KanbanCard
              opp={activeDragCard}
              advisors={advisors}
              showAdvisor={isAdmin}
              onOpenQuickView={() => undefined}
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      <QuickView
        opp={quickViewOpp}
        stage={quickViewStage}
        advisors={advisors}
        onClose={() => setQuickViewId(null)}
      />

      <LossReasonModal
        open={!!pendingLoss}
        reasons={lossReasons}
        onCancel={cancelLoss}
        onConfirm={confirmLoss}
      />

      <PipelineToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

