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
  deriveOriginIndicator,
  resolveAdvisor,
} from "./utils";

interface Props {
  opp: KanbanOpportunity;
  advisors: AdvisorOption[];
  showAdvisor: boolean;
  isDraggingDisabled?: boolean;
  /**
   * Handler de click sobre la card (M6 — B5). El padre conecta esto
   * a la URL `?opp=<id>` que el `OpportunityDialog` observa. Cuando
   * no se provee (DragOverlay), el click no hace nada.
   *
   * dnd-kit distingue click vs drag por la activationConstraint del
   * PointerSensor (6px en pipeline-board): si el pointer no se movió,
   * React dispara `click` normalmente. Si se inició drag, el click
   * no se emite.
   */
  onSelect?: (opportunityId: UUID) => void;
}

/**
 * Card minimalista del kanban (M5).
 *
 * Muestra: nombre, monto, indicador origen, asesor (solo si admin),
 * y badge "Sin cotización formal" cuando una opp está en Cotización
 * sin Draft Order Shopify (caso "drag manual antes del DO").
 *
 * El doble click rápido se bloquea a nivel padre via idempotencia
 * del servicio `pipeline-move`. La card es puramente draggable —
 * el quick-view se eliminó tras CHECKPOINT M5 (decisión de producto:
 * M6 trae popup único de detalle completo, sin preview intermedio).
 * El click sobre la card no abre nada entre M5 y M6.
 *
 * Diseño funcional pero no pulido — F7 itera la estética.
 */
export function KanbanCard({
  opp,
  advisors,
  showAdvisor,
  isDraggingDisabled,
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
  const origin = deriveOriginIndicator(opp);
  const advisor = resolveAdvisor(opp.assigned_advisor_id, advisors);
  const name = contactDisplayName(opp.contact);
  const isCustomer = contactIsCustomer(opp.contact);

  // Edge case: opp en "Cotización" sin Draft Order. Solo lo
  // detectamos cuando la opp tiene `funnel = venta` y no hay
  // Draft Order y NO hay won_at. El nombre de la etapa lo conoce
  // la columna padre — aquí mostramos badge si aplica.
  const lacksDraftOrder =
    opp.funnel === "venta" && !opp.shopify_draft_order_id;

  // Click vs drag: si dnd-kit no inició el drag (pointer no se movió
  // > activationConstraint), React dispara `click` normalmente. Si
  // se inició drag, el click no se emite — el navegador no produce
  // click después de un dragstart. Por eso onClick es seguro al lado
  // de los listeners de drag.
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
        "group bg-white dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700",
        "p-3 select-none shadow-sm hover:shadow-md transition-shadow",
        "focus:outline-none focus:ring-2 focus:ring-indigo-400",
        onSelect ? "cursor-pointer active:cursor-grabbing" : "cursor-grab active:cursor-grabbing",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {name}
        </p>
        <OriginBadge origin={origin} />
      </div>

      {opp.display_reference && (
        <p className="text-xs text-gray-400 dark:text-gray-500 truncate">
          {opp.display_reference}
        </p>
      )}

      <div className="flex items-baseline justify-between mt-2 gap-2">
        <span
          className={[
            "text-sm font-semibold tabular-nums",
            amount.isMissing
              ? "text-gray-400 dark:text-gray-500 italic"
              : amount.isEstimated
                ? "text-amber-700 dark:text-amber-300"
                : "text-gray-900 dark:text-gray-100",
          ].join(" ")}
        >
          {amount.text}
        </span>
        <ContactTypeBadge isCustomer={isCustomer} />
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

      {lacksDraftOrder && amount.isEstimated && (
        <p className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mt-1">
          Sin cotización formal
        </p>
      )}
    </div>
  );
}

function OriginBadge({ origin }: { origin: "shopify" | "whaapy_or_auto" }) {
  const label = origin === "shopify" ? "Shopify" : "Whaapy";
  return (
    <span
      className={[
        "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0",
        origin === "shopify"
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
          : "bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
      ].join(" ")}
    >
      {label}
    </span>
  );
}

function ContactTypeBadge({ isCustomer }: { isCustomer: boolean }) {
  return (
    <span
      className={[
        "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0",
        isCustomer
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300"
          : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
      ].join(" ")}
    >
      {isCustomer ? "Cliente" : "Lead"}
    </span>
  );
}
