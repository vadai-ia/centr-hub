"use client";
import type { TimelineEvent } from "@/lib/services/timeline";
import { formatRelative } from "@/app/(dashboard)/contactos/utils";

interface Props {
  events: TimelineEvent[];
}

/**
 * Timeline embebido en el popup de oportunidad (M6 — B4).
 *
 * Mismo modelo que el timeline del detalle de contacto (B3), pero
 * scope reducido a la oportunidad y diseño más compacto para caber
 * dentro del popup sin saturar.
 */
export function OpportunityTimeline({ events }: Props) {
  if (events.length === 0) {
    return (
      <section className="bg-white dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700 p-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
          Historia
        </h3>
        <p className="text-sm text-gray-400 dark:text-gray-500 italic">
          Sin eventos para esta oportunidad.
        </p>
      </section>
    );
  }

  return (
    <section className="bg-white dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700">
      <header className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
          Historia
        </h3>
      </header>
      <ol className="divide-y divide-gray-100 dark:divide-gray-700 max-h-72 overflow-y-auto">
        {events.map((ev) => (
          <li key={ev.id} className="px-4 py-2.5 flex items-start gap-3">
            <span
              className="inline-block w-2 h-2 rounded-full flex-shrink-0 mt-1.5"
              style={{ backgroundColor: kindColor(ev.kind) }}
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-900 dark:text-gray-100">{ev.label}</p>
              {ev.description && (
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5 whitespace-pre-wrap">
                  {ev.description}
                </p>
              )}
              <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
                {formatRelative(ev.occurredAt)}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function kindColor(kind: TimelineEvent["kind"]): string {
  switch (kind) {
    case "stage_change":
      return "#6366F1";
    case "order_paid":
      return "#10B981";
    case "order_cancelled":
      return "#EF4444";
    case "task_created":
    case "task_completed":
      return "#F59E0B";
    case "manual_note":
      return "#0EA5E9";
    case "reassignment":
    case "contact_edited":
      return "#8B5CF6";
    case "opportunity_auto_created":
      return "#FBBF24";
    default:
      return "#9CA3AF";
  }
}
