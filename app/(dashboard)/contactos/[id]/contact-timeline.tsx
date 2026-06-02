import type { TimelineEvent } from "@/lib/services/timeline";
import { OpportunityTimeline } from "@/components/opportunity/opportunity-timeline";

interface Props {
  events: TimelineEvent[];
}

/**
 * Timeline unificado del contacto (M6 — B3 + lote polish).
 *
 * Reusa el componente OpportunityTimeline con `showOpportunityReference`
 * para que cada evento muestre a qué oportunidad pertenece — necesario
 * cuando un contacto tiene varias opps activas y los eventos se mezclan.
 */
export function ContactTimeline({ events }: Props) {
  return <OpportunityTimeline events={events} showOpportunityReference />;
}
