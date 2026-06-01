import type { TimelineEvent } from "@/lib/services/timeline";
import { formatRelative } from "../utils";

interface Props {
  events: TimelineEvent[];
}

/**
 * Timeline unificado del contacto (M6 — B3).
 *
 * Server Component puro — renderiza una lista en orden cronológico
 * descendente. Cada evento se pinta con un dot de color según kind
 * y un label resumido. El `meta` se usa para tooltips opcionales
 * (no implementado en B3, F7 puede pulir).
 */
export function ContactTimeline({ events }: Props) {
  if (events.length === 0) {
    return (
      <section className="bg-white dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700 p-4">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
          Timeline
        </h2>
        <p className="text-sm text-gray-400 dark:text-gray-500 italic">
          Sin eventos registrados para este contacto.
        </p>
      </section>
    );
  }

  return (
    <section className="bg-white dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700">
      <header className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
          Timeline
        </h2>
      </header>
      <ol className="divide-y divide-gray-100 dark:divide-gray-700">
        {events.map((ev) => (
          <li key={ev.id} className="px-4 py-3 flex items-start gap-3">
            <span
              className="inline-block w-2 h-2 rounded-full flex-shrink-0 mt-1.5"
              style={{ backgroundColor: kindColor(ev.kind) }}
              aria-hidden
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-900 dark:text-gray-100">
                {ev.label}
              </p>
              {ev.description && (
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
                  {ev.description}
                </p>
              )}
              <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
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
      return "#6366F1"; // indigo
    case "order_paid":
      return "#10B981"; // emerald
    case "order_cancelled":
      return "#EF4444"; // red
    case "task_created":
    case "task_completed":
      return "#F59E0B"; // amber
    case "manual_note":
      return "#0EA5E9"; // sky
    case "reassignment":
    case "contact_edited":
      return "#8B5CF6"; // violet
    case "contact_created_in_shopify":
    case "contact_matched_in_shopify":
      return "#34D399"; // emerald-light
    case "contact_created_in_whaapy":
      return "#22D3EE"; // cyan
    case "opportunity_auto_created":
      return "#FBBF24"; // amber-light
    default:
      return "#9CA3AF"; // gray
  }
}
