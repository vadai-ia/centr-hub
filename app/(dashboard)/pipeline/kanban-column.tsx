"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { KanbanOpportunity } from "@/lib/db/opportunities";
import type {
  AdvisorOption,
  LoadPageActionResult,
} from "@/lib/types/pipeline";
import type { PipelineStageRow, UUID } from "@/lib/types/database";
import { PIPELINE_VIRTUALIZATION_THRESHOLD } from "@/lib/constants";
import { KanbanCard } from "./kanban-card";

interface Props {
  stage: PipelineStageRow;
  cards: KanbanOpportunity[];
  hasMore: boolean;
  advisors: AdvisorOption[];
  showAdvisor: boolean;
  page: number;
  isOverlay?: boolean;
  onLoadMore: (
    stage: PipelineStageRow,
    page: number,
  ) => Promise<LoadPageActionResult>;
  /** Click sobre una card (M6 — B5) → abre popup vía URL ?opp=<id>. */
  onSelectOpportunity?: (opportunityId: UUID) => void;
}

/**
 * Una columna del kanban: header (nombre + count + color), lista de
 * cards con virtualización condicional (>50), botón cargar más
 * cuando server-side dice `hasMore`, y droppable activo siempre que
 * el funnel y la etapa estén activos.
 *
 * Virtualización: si el número de cards >= `PIPELINE_VIRTUALIZATION_THRESHOLD`,
 * usamos `@tanstack/react-virtual`. Si no, render directo para evitar
 * el overhead de medición (cards de altura variable, mejor manual).
 */
export function KanbanColumn({
  stage,
  cards,
  hasMore,
  advisors,
  showAdvisor,
  page,
  isOverlay,
  onLoadMore,
  onSelectOpportunity,
}: Props) {
  const droppable = useDroppable({
    id: stage.id,
    data: { stageId: stage.id, funnel: stage.funnel },
    disabled: isOverlay,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const handleLoadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    try {
      await onLoadMore(stage, page + 1);
    } finally {
      setIsLoadingMore(false);
    }
  }, [hasMore, isLoadingMore, onLoadMore, page, stage]);

  // Scroll al final → cargar más. Solo cuando hay >= virtualization
  // threshold para no inflar el observer en columnas pequeñas.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !hasMore) return;
    const onScroll = () => {
      const buffer = 200;
      if (
        el.scrollTop + el.clientHeight >=
        el.scrollHeight - buffer
      ) {
        void handleLoadMore();
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [handleLoadMore, hasMore]);

  const useVirtual = cards.length >= PIPELINE_VIRTUALIZATION_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: useVirtual ? cards.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 116,
    overscan: 6,
    enabled: useVirtual,
  });

  return (
    <div
      ref={droppable.setNodeRef}
      className={[
        "flex flex-col w-72 flex-shrink-0 rounded-lg",
        "bg-gray-100 dark:bg-gray-800/60",
        droppable.isOver
          ? "ring-2 ring-indigo-400 ring-offset-2 ring-offset-gray-50 dark:ring-offset-gray-900"
          : "",
      ].join(" ")}
      data-testid={`kanban-column-${stage.id}`}
    >
      <div className="px-3 pt-3 pb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: stage.color }}
            aria-hidden
          />
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 truncate">
            {stage.name}
          </h3>
        </div>
        <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums flex-shrink-0">
          {cards.length}
          {hasMore ? "+" : ""}
        </span>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-2 pb-2"
        style={{ maxHeight: "calc(100vh - 14rem)" }}
      >
        {cards.length === 0 ? (
          <EmptyState />
        ) : useVirtual ? (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const opp = cards[vi.index];
              return (
                <div
                  key={opp.id}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${vi.start}px)`,
                  }}
                  className="pb-2"
                >
                  <KanbanCard
                    opp={opp}
                    advisors={advisors}
                    showAdvisor={showAdvisor}
                    onSelect={onSelectOpportunity}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-2">
            {cards.map((opp) => (
              <KanbanCard
                key={opp.id}
                opp={opp}
                advisors={advisors}
                showAdvisor={showAdvisor}
                onSelect={onSelectOpportunity}
              />
            ))}
          </div>
        )}

        {hasMore && (
          <button
            type="button"
            onClick={() => void handleLoadMore()}
            disabled={isLoadingMore}
            className="w-full mt-2 py-2 text-xs text-indigo-600 dark:text-indigo-400 hover:bg-white dark:hover:bg-gray-700 rounded transition-colors disabled:opacity-50"
          >
            {isLoadingMore ? "Cargando..." : "Cargar más"}
          </button>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-8 text-xs text-gray-400 dark:text-gray-500">
      Sin oportunidades
    </div>
  );
}
