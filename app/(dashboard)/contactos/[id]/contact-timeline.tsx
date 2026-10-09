"use client";
import { useMemo, useState } from "react";
import type { TimelineEvent } from "@/lib/services/timeline";
import {
  TIMELINE_CATEGORY_LABELS,
  TIMELINE_CATEGORY_ORDER,
  type TimelineCategory,
} from "@/lib/services/timeline-catalog";
import { OpportunityTimeline } from "@/components/opportunity/opportunity-timeline";

interface Props {
  events: TimelineEvent[];
}

/**
 * Bitácora del cliente (punto 24 — antes "timeline unificado").
 *
 * Reusa `OpportunityTimeline` para la lista y le agrega el filtro por
 * categoría. El filtro es del LADO DEL CLIENTE a propósito: medido en
 * producción, un contacto tiene 3 hechos de negocio en la mediana y 13 el
 * que más, así que la bitácora entera ya viene en la respuesta y filtrar es
 * instantáneo. Si algún día un contacto acumulara cientos, el filtro tendría
 * que irse al servidor — filtrar en el navegador sobre una lista truncada
 * mostraría "0 mensajes" cuando sí los hay, más abajo del corte.
 *
 * Solo se ofrecen las categorías que ESTE cliente tiene: una botonera con
 * seis filtros donde cuatro no devuelven nada no ayuda a nadie.
 */
export function ContactTimeline({ events }: Props) {
  const [active, setActive] = useState<TimelineCategory | null>(null);

  const presentes = useMemo(() => {
    const counts = new Map<TimelineCategory, number>();
    for (const ev of events) {
      counts.set(ev.category, (counts.get(ev.category) ?? 0) + 1);
    }
    return TIMELINE_CATEGORY_ORDER.filter((c) => counts.has(c)).map((c) => ({
      category: c,
      count: counts.get(c)!,
    }));
  }, [events]);

  const visibles = useMemo(
    () => (active === null ? events : events.filter((e) => e.category === active)),
    [events, active],
  );

  return (
    <div className="space-y-3">
      {presentes.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip
            label={`Todo (${events.length})`}
            selected={active === null}
            onClick={() => setActive(null)}
          />
          {presentes.map(({ category, count }) => (
            <Chip
              key={category}
              label={`${TIMELINE_CATEGORY_LABELS[category]} (${count})`}
              selected={active === category}
              onClick={() => setActive(category)}
            />
          ))}
        </div>
      )}
      <OpportunityTimeline events={visibles} showOpportunityReference />
    </div>
  );
}

function Chip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={[
        "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
        selected
          ? "bg-indigo-600 text-white"
          : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
