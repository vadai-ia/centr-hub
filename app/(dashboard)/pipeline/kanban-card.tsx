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
  /** True si la card vive en la columna "Caso problemático" (M4v2): si
   *  además no está resuelta, muestra el botón "Caso resuelto". */
  canResolveCase?: boolean;
  /** Dispara el cierre de caso desde el card (M4v2). */
  onResolveCase?: (opportunityId: UUID) => void;
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
  canResolveCase,
  onResolveCase,
  onSelect,
}: Props) {
  const draggable = useDraggable({
    id: opp.id,
    // Un caso resuelto está archivado: no se arrastra (el motor tampoco lo
    // toca). Solo se consulta en la vista "Casos resueltos".
    disabled: isDraggingDisabled || opp.resolved_at !== null,
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

  // "Caso resuelto" (M4v2): solo en cards de "Caso problemático" aún
  // abiertas. El servidor re-valida permisos (admin o asesor asignado);
  // como el vendedor solo ve sus propias opps, cualquier card que vea es
  // resoluble por él.
  const showResolve =
    !!canResolveCase && opp.resolved_at === null && !!onResolveCase;

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
        // Ronda 2 #9: sin outline amber al focus (el dnd-kit ya marca
        // visualmente la card durante el drag con el opacity 0.4).
        // Ronda 2 #11: escala ~80% — paddings y font-sizes reducidos.
        "group relative bg-white dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700",
        "p-2 pl-2.5 select-none shadow-sm hover:shadow-md hover:border-gray-300 dark:hover:border-gray-600 transition-all",
        "outline-none",
        onSelect ? "cursor-pointer active:cursor-grabbing" : "cursor-grab active:cursor-grabbing",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-1.5 mb-0.5">
        <p className="text-[13px] font-semibold text-gray-900 dark:text-gray-100 truncate leading-snug">
          {name}
        </p>
        <div className="flex items-center gap-1 flex-shrink-0">
          {opp.resolved_at && <ResolvedBadge />}
          {!opp.resolved_at && opp.reopened_at && <ReopenedBadge />}
          {pendingTasksCount !== undefined && pendingTasksCount > 0 && (
            <TasksBadge count={pendingTasksCount} />
          )}
          <ContactTypeBadge isCustomer={isCustomer} />
        </div>
      </div>

      {opp.display_reference && (
        <p className="text-[10px] font-mono text-gray-400 dark:text-gray-500 truncate">
          {opp.display_reference}
        </p>
      )}

      <div className="flex items-baseline justify-between mt-1.5 gap-2">
        {noAmount && phone ? (
          <a
            href={`tel:${phone}`}
            onClick={(e) => e.stopPropagation()}
            className="text-[12px] font-medium text-blue-700 dark:text-blue-300 hover:underline truncate"
          >
            {phone}
          </a>
        ) : (
          <span
            className={[
              "text-[14px] font-bold tabular-nums leading-none",
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
        <div className="flex items-center gap-1.5 mt-1.5 pt-1.5 border-t border-gray-100 dark:border-gray-700">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: advisor.color }}
            aria-hidden
          />
          <span
            className={[
              "text-[11px] truncate",
              advisor.isUnassigned
                ? "text-amber-700 dark:text-amber-300 italic"
                : "text-gray-600 dark:text-gray-400",
            ].join(" ")}
          >
            {advisor.fullName}
          </span>
        </div>
      )}

      {showResolve && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onResolveCase!(opp.id);
          }}
          // El drag-source captura pointer events; detener la propagación
          // del pointer evita iniciar un drag al presionar el botón.
          onPointerDown={(e) => e.stopPropagation()}
          className="w-full mt-2 py-1 text-[11px] font-medium rounded border border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors"
        >
          Caso resuelto
        </button>
      )}
    </div>
  );
}

function ResolvedBadge() {
  return (
    <span
      className="text-[9px] uppercase tracking-wide px-1 py-px rounded font-medium flex-shrink-0 bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
      title="Caso resuelto y archivado"
    >
      Resuelto
    </span>
  );
}

function ReopenedBadge() {
  return (
    <span
      className="text-[9px] uppercase tracking-wide px-1 py-px rounded font-medium flex-shrink-0 bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300"
      title="Oportunidad reabierta en Caso problemático"
    >
      Reabierto
    </span>
  );
}

function TasksBadge({ count }: { count: number }) {
  return (
    <span
      className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1 py-px rounded-full bg-blue-600 text-white flex-shrink-0"
      title={`${count} tarea${count === 1 ? "" : "s"} pendiente${count === 1 ? "" : "s"}`}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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
        "text-[9px] uppercase tracking-wide px-1 py-px rounded font-medium flex-shrink-0",
        isCustomer
          ? "bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300"
          : "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
      ].join(" ")}
    >
      {isCustomer ? "Cliente" : "Lead"}
    </span>
  );
}
