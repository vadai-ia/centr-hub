"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
import { OpportunityDialog } from "@/components/opportunity/opportunity-dialog";
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
import { PipelineFiltersBar, type ActiveFilters } from "./pipeline-filters-bar";

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
 *   - Modal de motivo de pérdida (sin quick-view — eliminado tras
 *     CHECKPOINT M5; M6 trae popup único de detalle completo).
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

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  /**
   * Handler de selección de card (M6 — B5). La card es un drag-source
   * de dnd-kit; el click solo se dispara si NO se inició drag (regla
   * estándar del browser tras un dragstart). Cuando dispara, navegamos
   * con `?opp=<id>` preservando los demás params; el `OpportunityDialog`
   * montado abajo escucha ese param y abre el popup.
   */
  const handleSelectOpportunity = useCallback(
    (oppId: UUID) => {
      const next = new URLSearchParams(searchParams.toString());
      next.set("opp", oppId);
      const qs = next.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

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
  const [countsByStage, setCountsByStage] = useState<Record<UUID, number>>(
    initial.countsByStage,
  );
  const [pendingTasksByOpp, setPendingTasksByOpp] = useState<Record<UUID, number>>(
    initial.pendingTasksByOpp,
  );
  const [pageByStage, setPageByStage] = useState<PageByStage>(() =>
    initialPageByStage(initial.stages),
  );
  const [filters, setFilters] = useState<ActiveFilters>({
    dateFrom: null,
    dateTo: null,
    advisorId: null,
    query: "",
  });

  const [advisors] = useState(initial.advisors);
  const [lossReasons] = useState(initial.lossReasons);
  const [effectiveAdvisorId, setEffectiveAdvisorId] = useState<
    UUID | null | undefined
  >(initial.effectiveAdvisorId);

  const [activeDragId, setActiveDragId] = useState<UUID | null>(null);
  const [pendingLoss, setPendingLoss] = useState<PendingLoss | null>(null);
  const [pendingMoves, setPendingMoves] = useState<Set<UUID>>(new Set());
  const { toasts, push: pushToast, dismiss: dismissToast } = useToastStack();

  // Stages indexados por id — útil para hot lookups en drag/realtime.
  const stagesById = useMemo(() => {
    const map: Record<UUID, PipelineStageRow> = {};
    for (const s of stages) map[s.id] = s;
    return map;
  }, [stages]);

  // Ref del estado de cards para que el handler de realtime pueda leer
  // la etapa previa de una opp sin re-crear el callback en cada cambio.
  const cardsRef = useRef(cardsByStage);
  useEffect(() => {
    cardsRef.current = cardsByStage;
  }, [cardsByStage]);

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
      // Toast del trigger F1→F2 (M7.2 B2): si la card transita de una
      // etapa NO ganada a una etapa Ganada y trae `shopify_order_id`
      // (firma exclusiva del trigger — el cierre manual nunca lo
      // popula), es la completación del Draft Order vía webhook.
      const newStage = stagesById[opp.stage_id];
      if (newStage?.is_won && opp.shopify_order_id) {
        let prevStageId: UUID | null = null;
        for (const [sid, list] of Object.entries(cardsRef.current)) {
          if (list.some((o) => o.id === opp.id)) {
            prevStageId = sid as UUID;
            break;
          }
        }
        const prevStage = prevStageId ? stagesById[prevStageId] : undefined;
        if (prevStage && !prevStage.is_won) {
          pushToast(
            "Cotización completada. Se creó seguimiento en Post-venta.",
            "success",
          );
        }
      }
      setCardsByStage((cur) => upsertOpp(cur, opp, stagesById));
    },
    [effectiveAdvisorId, stagesById, pushToast],
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
      setCountsByStage(state.countsByStage);
      setPendingTasksByOpp(state.pendingTasksByOpp);
      setPageByStage(() => initialPageByStage(state.stages));
      if (updateAdvisor) setEffectiveAdvisorId(state.effectiveAdvisorId);
    },
    [],
  );

  const handlePollingTick = useCallback(async () => {
    const res = await loadInitialPipelineState({
      funnel,
      unassignedFilter: isAdmin && unassignedFilter,
      filters: filtersToPayload(filters),
    });
    if (res.ok) applyState(res.state, false);
  }, [applyState, funnel, isAdmin, unassignedFilter, filters]);

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
      filters: filtersToPayload(filters),
    });
    if (res.ok) applyState(res.state, true);
  }

  async function changeUnassignedFilter(next: boolean) {
    setUnassignedFilter(next);
    const res = await loadInitialPipelineState({
      funnel,
      unassignedFilter: isAdmin && next,
      filters: filtersToPayload(filters),
    });
    if (res.ok) applyState(res.state, true);
  }

  async function changeFilters(next: ActiveFilters) {
    setFilters(next);
    const res = await loadInitialPipelineState({
      funnel,
      unassignedFilter: isAdmin && unassignedFilter,
      filters: filtersToPayload(next),
    });
    if (res.ok) applyState(res.state, true);
  }

  // ----- Paginación por columna -----
  async function loadMoreForStage(stage: PipelineStageRow, page: number) {
    const payload = filtersToPayload(filters);
    const res = await loadKanbanPageAction({
      funnel,
      stageId: stage.id,
      page,
      assignedAdvisorId: effectiveAdvisorId,
      dateFrom: payload.dateFrom,
      dateTo: payload.dateTo,
      query: payload.query,
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

      <PipelineFiltersBar
        filters={filters}
        advisors={advisors}
        showAdvisorFilter={isAdmin}
        onChange={changeFilters}
      />

      <DndContext
        sensors={dndSensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="flex-1 overflow-x-auto centr-scrollbar">
          <div className="flex gap-2 pb-2 min-w-min">
            {stages.map((stage) => (
              <KanbanColumn
                key={stage.id}
                stage={stage}
                cards={cardsByStage[stage.id] ?? []}
                hasMore={hasMoreByStage[stage.id] ?? false}
                advisors={advisors}
                showAdvisor={isAdmin}
                page={pageByStage[stage.id] ?? 0}
                totalCount={countsByStage[stage.id]}
                pendingTasksByOpp={pendingTasksByOpp}
                onLoadMore={loadMoreForStage}
                onSelectOpportunity={handleSelectOpportunity}
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
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      <LossReasonModal
        open={!!pendingLoss}
        reasons={lossReasons}
        onCancel={cancelLoss}
        onConfirm={confirmLoss}
      />

      <OpportunityDialog />

      <PipelineToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}


function filtersToPayload(filters: ActiveFilters): {
  dateFrom?: string;
  dateTo?: string;
  advisorId?: UUID;
  query?: string;
} {
  return {
    dateFrom: filters.dateFrom ? `${filters.dateFrom}T00:00:00.000Z` : undefined,
    dateTo: filters.dateTo ? `${filters.dateTo}T23:59:59.999Z` : undefined,
    advisorId: filters.advisorId ?? undefined,
    query: filters.query.trim().length > 0 ? filters.query.trim() : undefined,
  };
}
