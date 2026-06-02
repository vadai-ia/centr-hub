"use client";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { KanbanOpportunity } from "@/lib/db/opportunities";
import type { AdvisorOption } from "@/lib/types/pipeline";
import type { UUID } from "@/lib/types/database";
import {
  contactDisplayName,
  contactIsCustomer,
  deriveDisplayAmount,
  resolveAdvisor,
} from "./utils";

interface Props {
  opp: KanbanOpportunity;
  advisors: AdvisorOption[];
  showAdvisor: boolean;
  isDraggingDisabled?: boolean;
  /** Tareas pendientes asociadas a la opp (lote polish M6). */
  pendingTasksCount?: number;
  onSelect?: (opportunityId: UUID) => void;
}

/**
 * Card del kanban (M5 + lote polish M6).
 *
 * Lote polish M6:
 *  - Si no hay monto (lead nuevo sin cotización), muestra el teléfono
 *    del contacto en lugar de "Sin monto".
 *  - Si hay tareas pendientes, muestra un badge con contador.
 *  - Bordes más definidos + acento de etapa en la franja izquierda.
 */
export function KanbanCard({
  opp,
  advisors,
  showAdvisor,
  isDraggingDisabled,
  pendingTasksCount,
  onSelect,
}: Props) {
  const draggable = useDraggable({
    id: opp.id,
    disabled: isDraggingDisabled,
    data: {
      opportunityId: opp.id,
      fromStageId: opp.stage_id,
      lastModifiedAt: opp.last_modified_at,
    },
  });

  const style = {
    transform: CSS.Translate.toString(draggable.transform),
    opacity: draggable.isDragging ? 0.4 : 1,
    touchAction: "none" as const,
  };

  const amount = deriveDisplayAmount(opp);
  const advisor = resolveAdvisor(opp.assigned_advisor_id, advisors);
  const name = contactDisplayName(opp.contact);
  const isCustomer = contactIsCustomer(opp.contact);

  // Lead sin cotización: el monto no aporta valor — mostramos el
  // teléfono para que el vendedor pueda llamar sin abrir la card.
  const noAmount = amount.isMissing;
  const phone = opp.contact?.phone ?? null;

  const handleClick = onSelect
    ? () => {
        if (draggable.isDragging) return;
        onSelect(opp.id);
      }
    : undefined;

  return (
    <div
      ref={draggable.setNodeRef}
      style={style}
      {...draggable.listeners}
      {...draggable.attributes}
      onClick={handleClick}
      aria-label={`Oportunidad de ${name}`}
      role={onSelect ? "button" : undefined}
      className={[
        "group relative bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700",
        "p-3 pl-3.5 select-none shadow-sm hover:shadow-md hover:border-gray-300 dark:hover:border-gray-600 transition-all",
        "focus:outline-none focus:ring-2 focus:ring-amber-400",
        onSelect ? "cursor-pointer active:cursor-grabbing" : "cursor-grab active:cursor-grabbing",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
          {name}
        </p>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {pendingTasksCount !== undefined && pendingTasksCount > 0 && (
            <TasksBadge count={pendingTasksCount} />
          )}
          <ContactTypeBadge isCustomer={isCustomer} />
        </div>
      </div>

      {opp.display_reference && (
        <p className="text-[11px] font-mono text-gray-400 dark:text-gray-500 truncate">
          {opp.display_reference}
        </p>
      )}

      <div className="flex items-baseline justify-between mt-2 gap-2">
        {noAmount && phone ? (
          <a
            href={`tel:${phone}`}
            onClick={(e) => e.stopPropagation()}
            className="text-sm font-medium text-blue-700 dark:text-blue-300 hover:underline truncate"
          >
            {phone}
          </a>
        ) : (
          <span
            className={[
              "text-base font-bold tabular-nums",
              amount.isMissing
                ? "text-gray-300 dark:text-gray-600 italic"
                : amount.isEstimated
                  ? "text-amber-700 dark:text-amber-300"
                  : "text-gray-900 dark:text-gray-100",
            ].join(" ")}
          >
            {amount.text}
          </span>
        )}
      </div>

      {showAdvisor && (
        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-gray-100 dark:border-gray-700">
          <span
            className="inline-block w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: advisor.color }}
            aria-hidden
          />
          <span
            className={[
              "text-xs truncate",
              advisor.isUnassigned
                ? "text-amber-700 dark:text-amber-300 italic"
                : "text-gray-600 dark:text-gray-400",
            ].join(" ")}
          >
            {advisor.fullName}
          </span>
        </div>
      )}
    </div>
  );
}

function TasksBadge({ count }: { count: number }) {
  return (
    <span
      className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-blue-600 text-white flex-shrink-0"
      title={`${count} tarea${count === 1 ? "" : "s"} pendiente${count === 1 ? "" : "s"}`}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <polyline points="9 11 12 14 22 4"/>
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
      </svg>
      {count}
    </span>
  );
}

function ContactTypeBadge({ isCustomer }: { isCustomer: boolean }) {
  return (
    <span
      className={[
        "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium flex-shrink-0",
        isCustomer
          ? "bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300"
          : "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
      ].join(" ")}
    >
      {isCustomer ? "Cliente" : "Lead"}
    </span>
  );
}
