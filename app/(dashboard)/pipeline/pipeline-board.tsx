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
  setHideClosedDaysAction,
} from "@/lib/actions/pipeline";
import { OpportunityDialog } from "@/components/opportunity/opportunity-dialog";
import { ResolveCaseDialog } from "@/components/opportunity/resolve-case-dialog";
import { ReopenCaseDialog } from "./reopen-case-dialog";
import type { KanbanOpportunity } from "@/lib/db/opportunities";
import type {
  PipelineInitialState,
} from "@/lib/types/pipeline";
import type {
  Funnel,
  PipelineStageRow,
  UUID,
} from "@/lib/types/database";
import { channelOutboundValue, type Channel } from "@/lib/types/dashboard";
import { KanbanCard } from "./kanban-card";
import { KanbanColumn } from "./kanban-column";
import { LossReasonModal } from "./loss-reason-modal";
import { HandoffDialog } from "@/components/opportunity/handoff-dialog";
import { PipelineToolbar } from "./pipeline-toolbar";
import { CreateLeadButton } from "@/components/leads/create-lead-dialog";
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
  /** True si el rol alcanza todos los datos (admin/superadmin/SDR) — 0039. */
  canSeeAll: boolean;
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
  canSeeAll,
  userId,
  organizationId,
  unassignedFilter: initialUnassigned,
}: Props) {
  void userId;
  const isAdmin = canSeeAll;

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
  const [hiddenClosedByStage, setHiddenClosedByStage] = useState<Record<UUID, number>>(
    initial.hiddenClosedByStage,
  );
  const [hideClosedAfterDays, setHideClosedAfterDays] = useState<number>(
    initial.hideClosedAfterDays,
  );
  // Etapas cerradas en las que el usuario pidió "Ver cerradas" (muestra
  // también las auto-ocultas). Local a la sesión de tablero; se resetea
  // en cada applyState (toggle funnel/filtro/umbral/polling).
  const [showClosedByStage, setShowClosedByStage] = useState<Set<UUID>>(
    () => new Set(),
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
    customerSuccessId: null,
    query: "",
    channel: "all",
  });
  // Vista "Casos resueltos" (solo Post-venta): muestra el archivo de casos
  // cerrados en vez del pipeline activo. Se resetea al cambiar de funnel.
  const [resolvedView, setResolvedView] = useState(false);
  // Id de la etapa "Caso problemático" (solo Post-venta) — habilita el
  // botón "Caso resuelto" en sus cards (M4v2). null en Venta.
  const [problematicStageId, setProblematicStageId] = useState<UUID | null>(
    initial.problematicStageId,
  );
  // Caso a resolver desde el card (M4v2): abre ResolveCaseDialog a nivel
  // board reusando el mismo flujo que el popup de detalle.
  const [resolveCaseOppId, setResolveCaseOppId] = useState<UUID | null>(null);
  // Diálogo de reapertura (M4v2, botón "+" de Caso problemático).
  const [reopenOpen, setReopenOpen] = useState(false);

  const [advisors] = useState(initial.advisors);
  // Customer Success de la org (0047). Se re-siembra al cambiar de funnel
  // (el server solo lo puebla en Post-venta) — ver `applyState`.
  const [customerSuccess, setCustomerSuccess] = useState(initial.customerSuccess);
  const [lossReasons] = useState(initial.lossReasons);
  const [effectiveAdvisorId, setEffectiveAdvisorId] = useState<
    UUID | null | undefined
  >(initial.effectiveAdvisorId);

  const [activeDragId, setActiveDragId] = useState<UUID | null>(null);
  const [pendingLoss, setPendingLoss] = useState<PendingLoss | null>(null);
  const [pendingHandoff, setPendingHandoff] = useState<{ opp: KanbanOpportunity; fromStageId: UUID } | null>(null);
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

  // Canal activo leído por el handler de realtime sin re-crear el callback
  // en cada cambio de filtro (mismo patrón que cardsRef).
  const channelRef = useRef<Channel>(filters.channel);
  useEffect(() => {
    channelRef.current = filters.channel;
  }, [filters.channel]);

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
      // Archivo de casos: la vista activa no muestra resueltos y la vista
      // "Casos resueltos" solo muestra resueltos. Si una opp cruza esa
      // frontera (ej. se resolvió en otro tab), se saca de la vista actual.
      const isResolved = opp.resolved_at !== null;
      if (resolvedView !== isResolved) {
        setCardsByStage((cur) => removeOppById(cur, oppId));
        return;
      }
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
      // Corte por canal activo: si la opp dejó de matchear el canal filtrado
      // (ej. un handoff que cambió su origen), se saca del tablero. Misma
      // definición que el server (`channelOutboundValue`).
      const wantOutbound = channelOutboundValue(channelRef.current);
      if (wantOutbound !== null && opp.is_outbound !== wantOutbound) {
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
    [effectiveAdvisorId, stagesById, pushToast, resolvedView],
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
      setHiddenClosedByStage(state.hiddenClosedByStage);
      setHideClosedAfterDays(state.hideClosedAfterDays);
      setShowClosedByStage(new Set());
      setPendingTasksByOpp(state.pendingTasksByOpp);
      setProblematicStageId(state.problematicStageId);
      setPageByStage(() => initialPageByStage(state.stages));
      setCustomerSuccess(state.customerSuccess);
      if (updateAdvisor) setEffectiveAdvisorId(state.effectiveAdvisorId);
    },
    [],
  );

  const handlePollingTick = useCallback(async () => {
    const res = await loadInitialPipelineState({
      funnel,
      unassignedFilter: isAdmin && unassignedFilter,
      filters: filtersToPayload(filters, resolvedView),
    });
    if (res.ok) applyState(res.state, false);
  }, [applyState, funnel, isAdmin, unassignedFilter, filters, resolvedView]);

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
    // "Casos resueltos" es exclusivo de Post-venta: al salir, se apaga.
    const nextResolvedView = next === "post_venta" ? resolvedView : false;
    setResolvedView(nextResolvedView);
    // El filtro por Customer Success también es exclusivo de Post-venta: al
    // salir se limpia, o quedaría un filtro activo invisible (su select no
    // se pinta en Venta/Outbound) devolviendo cero resultados sin explicación.
    const nextFilters: ActiveFilters =
      next === "post_venta" ? filters : { ...filters, customerSuccessId: null };
    if (nextFilters !== filters) setFilters(nextFilters);
    const res = await loadInitialPipelineState({
      funnel: next,
      unassignedFilter: isAdmin && unassignedFilter,
      filters: filtersToPayload(nextFilters, nextResolvedView),
    });
    if (res.ok) applyState(res.state, true);
  }

  async function changeUnassignedFilter(next: boolean) {
    setUnassignedFilter(next);
    const res = await loadInitialPipelineState({
      funnel,
      unassignedFilter: isAdmin && next,
      filters: filtersToPayload(filters, resolvedView),
    });
    if (res.ok) applyState(res.state, true);
  }

  async function changeFilters(next: ActiveFilters) {
    setFilters(next);
    const res = await loadInitialPipelineState({
      funnel,
      unassignedFilter: isAdmin && unassignedFilter,
      filters: filtersToPayload(next, resolvedView),
    });
    if (res.ok) applyState(res.state, true);
  }

  async function changeResolvedView(next: boolean) {
    setResolvedView(next);
    const res = await loadInitialPipelineState({
      funnel,
      unassignedFilter: isAdmin && unassignedFilter,
      filters: filtersToPayload(filters, next),
    });
    if (res.ok) applyState(res.state, true);
  }

  // ----- Paginación por columna -----
  async function loadMoreForStage(stage: PipelineStageRow, page: number) {
    const payload = filtersToPayload(filters, resolvedView);
    const res = await loadKanbanPageAction({
      funnel,
      stageId: stage.id,
      page,
      assignedAdvisorId: effectiveAdvisorId,
      dateFrom: payload.dateFrom,
      dateTo: payload.dateTo,
      query: payload.query,
      showClosed: showClosedByStage.has(stage.id),
      resolvedScope: payload.resolvedScope,
      channel: payload.channel,
      customerSuccessId: payload.customerSuccessId,
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

  // ----- Auto-ocultar cerradas (Fix de pipeline P1) -----
  // "Ver cerradas" / "Ocultar cerradas" por columna cerrada: recarga la
  // primera página de esa etapa con/sin el filtro de ocultar.
  async function toggleClosedForStage(stage: PipelineStageRow) {
    const willShow = !showClosedByStage.has(stage.id);
    const payload = filtersToPayload(filters, resolvedView);
    const res = await loadKanbanPageAction({
      funnel,
      stageId: stage.id,
      page: 0,
      assignedAdvisorId: effectiveAdvisorId,
      dateFrom: payload.dateFrom,
      dateTo: payload.dateTo,
      query: payload.query,
      showClosed: willShow,
      resolvedScope: payload.resolvedScope,
      channel: payload.channel,
    });
    if (!res.ok) {
      pushToast(res.message, "error");
      return;
    }
    setCardsByStage((cur) => ({ ...cur, [stage.id]: res.items }));
    setHasMoreByStage((cur) => ({ ...cur, [stage.id]: res.hasMore }));
    setPageByStage((cur) => ({ ...cur, [stage.id]: 0 }));
    setShowClosedByStage((cur) => {
      const next = new Set(cur);
      if (willShow) next.add(stage.id);
      else next.delete(stage.id);
      return next;
    });
  }

  // Cambia el umbral global (admin): persiste + recarga el estado para
  // re-aplicar el ocultamiento con el valor nuevo.
  async function changeHideClosedDays(days: number) {
    const res = await setHideClosedDaysAction({ days });
    if (!res.ok) {
      pushToast(res.message, "error");
      return;
    }
    setHideClosedAfterDays(res.days);
    const state = await loadInitialPipelineState({
      funnel,
      unassignedFilter: isAdmin && unassignedFilter,
      filters: filtersToPayload(filters, resolvedView),
    });
    if (state.ok) applyState(state.state, false);
    pushToast(`Las cerradas se ocultan tras ${res.days} día(s).`, "success");
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

    // Fusión del handoff (F3 fix #2): en el board de Outbound, soltar en la
    // ÚLTIMA etapa ("Cliente calificado") NO mueve la card — abre el popup de
    // entrega. Confirmar → handoff (flip a Venta y sale de Outbound); cancelar
    // → la card NO se mueve (se queda donde estaba). Así no se puede olvidar.
    if (fromStage.funnel === "outbound") {
      const lastOutbound = [...stages].sort((a, b) => a.position - b.position).at(-1);
      if (lastOutbound && toStage.id === lastOutbound.id) {
        setPendingHandoff({ opp: card, fromStageId: fromStage.id });
        return;
      }
    }

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

  // ----- Caso resuelto desde el card (M4v2) -----
  // Reusa ResolveCaseDialog (mismo flujo que el popup de detalle). Al
  // resolver, el caso se archiva: refrescamos la opp → como la vista activa
  // no muestra resueltos, refreshOpportunity la saca del tablero.
  async function handleResolveCaseSuccess() {
    const oppId = resolveCaseOppId;
    setResolveCaseOppId(null);
    if (oppId) {
      await refreshOpportunity(oppId);
      pushToast("Caso marcado como resuelto y archivado.", "success");
    }
  }

  // ----- Reapertura a "Caso problemático" (M4v2) -----
  // La opp reabierta (mutada o hija nueva) aterriza activa en Caso
  // problemático del Post-venta. Recargamos el estado del funnel actual
  // (la reapertura ocurre desde la vista activa de Post-venta) para que
  // aparezca con su badge "Reabierto".
  async function handleReopenSuccess() {
    setReopenOpen(false);
    await handlePollingTick();
    pushToast("Oportunidad reabierta en Caso problemático.", "success");
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
        canSeeAll={canSeeAll}
        unassignedFilter={isAdmin && unassignedFilter}
        realtimeStatus={realtimeStatus}
        hideClosedAfterDays={hideClosedAfterDays}
        onFunnelChange={changeFunnel}
        onUnassignedToggle={changeUnassignedFilter}
        onHideClosedDaysChange={changeHideClosedDays}
        resolvedView={resolvedView}
        onResolvedViewToggle={changeResolvedView}
      />

      {/* Alta manual de lead en Outbound (solo funnel Outbound, que ya
          está gateado a admin/SDR). Dedup por identidad: convierte a un
          contacto inbound existente si el teléfono coincide. */}
      {funnel === "outbound" && canSeeAll && (
        <div className="flex justify-end mb-2">
          {/* onCreated recarga el estado del board para que el lead nuevo
              aparezca en vivo (el board no re-lee `initial` en router.refresh). */}
          <CreateLeadButton outbound onCreated={() => void handlePollingTick()} />
        </div>
      )}

      <PipelineFiltersBar
        filters={filters}
        advisors={advisors}
        showAdvisorFilter={isAdmin}
        customerSuccess={customerSuccess}
        showCustomerSuccessFilter={isAdmin && funnel === "post_venta"}
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
                customerSuccess={customerSuccess}
                showAdvisor={isAdmin}
                page={pageByStage[stage.id] ?? 0}
                totalCount={countsByStage[stage.id]}
                hiddenClosedCount={hiddenClosedByStage[stage.id] ?? 0}
                isClosedStage={stage.is_won || stage.is_lost}
                showingClosed={showClosedByStage.has(stage.id)}
                onToggleClosed={toggleClosedForStage}
                pendingTasksByOpp={pendingTasksByOpp}
                isProblematicStage={
                  problematicStageId !== null && stage.id === problematicStageId
                }
                onResolveCase={setResolveCaseOppId}
                onOpenReopen={resolvedView ? undefined : () => setReopenOpen(true)}
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
              customerSuccess={customerSuccess}
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

      <HandoffDialog
        open={!!pendingHandoff}
        opportunityId={pendingHandoff?.opp.id ?? null}
        advisors={advisors}
        onCancel={() => setPendingHandoff(null)}
        onSuccess={(msg) => {
          const ph = pendingHandoff;
          setPendingHandoff(null);
          if (ph) {
            // La opp flipeó a Venta → sale del board de Outbound.
            setCardsByStage((cur) => {
              const list = cur[ph.fromStageId] ?? [];
              return { ...cur, [ph.fromStageId]: list.filter((o) => o.id !== ph.opp.id) };
            });
            setCountsByStage((cur) => ({
              ...cur,
              [ph.fromStageId]: Math.max(0, (cur[ph.fromStageId] ?? 1) - 1),
            }));
          }
          pushToast(msg, "success");
        }}
      />

      <OpportunityDialog />

      <ResolveCaseDialog
        open={resolveCaseOppId !== null}
        opportunityId={resolveCaseOppId}
        onCancel={() => setResolveCaseOppId(null)}
        onSuccess={handleResolveCaseSuccess}
      />

      <ReopenCaseDialog
        open={reopenOpen}
        onCancel={() => setReopenOpen(false)}
        onSuccess={handleReopenSuccess}
      />

      <PipelineToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}


function filtersToPayload(
  filters: ActiveFilters,
  resolvedView: boolean,
): {
  dateFrom?: string;
  dateTo?: string;
  advisorId?: UUID;
  customerSuccessId?: UUID;
  query?: string;
  resolvedScope?: "active" | "resolved";
  channel?: Channel;
} {
  return {
    dateFrom: filters.dateFrom ? `${filters.dateFrom}T00:00:00.000Z` : undefined,
    dateTo: filters.dateTo ? `${filters.dateTo}T23:59:59.999Z` : undefined,
    advisorId: filters.advisorId ?? undefined,
    customerSuccessId: filters.customerSuccessId ?? undefined,
    query: filters.query.trim().length > 0 ? filters.query.trim() : undefined,
    resolvedScope: resolvedView ? "resolved" : undefined,
    // "all" es el default del server (sin corte) → se omite para no ensuciar
    // el payload y mantener la vista por defecto idéntica a hoy.
    channel: filters.channel !== "all" ? filters.channel : undefined,
  };
}
