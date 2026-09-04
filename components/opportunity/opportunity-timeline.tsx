"use client";
import type { TimelineEvent } from "@/lib/services/timeline";
import { formatRelative } from "@/app/(dashboard)/contactos/utils";

interface Props {
  events: TimelineEvent[];
  /** Si true, cada evento muestra a qué oportunidad pertenece. Útil
   *  cuando el timeline mezcla eventos de varias opps (ej. timeline
   *  del contacto). En el popup de UNA opp se mantiene en false. */
  showOpportunityReference?: boolean;
}

/**
 * Timeline del popup de oportunidad y del detalle de contacto.
 *
 * Lote polish M6:
 *  - Eventos con icono SVG por tipo (no solo dot).
 *  - Manual notes muestran el autor (resuelto server-side).
 *  - Si `showOpportunityReference`, cada evento muestra la opp asociada.
 */
export function OpportunityTimeline({ events, showOpportunityReference }: Props) {
  if (events.length === 0) {
    return (
      <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-2">Historia</h3>
        <p className="text-sm text-gray-400 dark:text-gray-500 italic">Sin eventos registrados.</p>
      </section>
    );
  }

  return (
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      <header className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2 bg-purple-50/40 dark:bg-purple-500/5">
        <span className="text-purple-600 dark:text-purple-400" aria-hidden>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
        </span>
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Historia</h3>
        <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
          {events.length} evento{events.length === 1 ? "" : "s"}
        </span>
      </header>
      <ol className="divide-y divide-gray-100 dark:divide-gray-700 max-h-80 overflow-y-auto">
        {events.map((ev) => (
          <li key={ev.id} className="px-4 py-3 flex items-start gap-3">
            <KindIcon kind={ev.kind} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm text-gray-900 dark:text-gray-100">{ev.label}</p>
                {showOpportunityReference && ev.opportunityReference && (
                  <span
                    className="text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
                    title="Oportunidad asociada"
                  >
                    {ev.opportunityReference}
                  </span>
                )}
              </div>
              {ev.description && (
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5 whitespace-pre-wrap">
                  {ev.description}
                </p>
              )}
              <div className="flex items-center gap-2 mt-1 text-[11px] text-gray-400 dark:text-gray-500 flex-wrap">
                <span>{formatRelative(ev.occurredAt)}</span>
                {ev.actorName && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="text-gray-500 dark:text-gray-400 font-medium">
                      {ev.actorName}
                    </span>
                  </>
                )}
                {ev.kind === "manual_note" && !ev.actorName && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="text-gray-500 dark:text-gray-400 italic">Sistema</span>
                  </>
                )}
                {ev.kind === "lead_message" && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="text-gray-500 dark:text-gray-400 italic">
                      Mensaje del formulario
                    </span>
                  </>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function KindIcon({ kind }: { kind: TimelineEvent["kind"] }) {
  const config = KIND_CONFIG[kind] ?? KIND_CONFIG.other_audit;
  return (
    <span
      className={`mt-0.5 inline-flex items-center justify-center w-7 h-7 rounded-full flex-shrink-0 ${config.bg}`}
      aria-hidden
    >
      <span className={config.text}>{config.icon}</span>
    </span>
  );
}

const KIND_CONFIG: Record<TimelineEvent["kind"], { bg: string; text: string; icon: JSX.Element }> = {
  stage_change: {
    bg: "bg-indigo-100 dark:bg-indigo-500/15",
    text: "text-indigo-700 dark:text-indigo-300",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14"/>
        <path d="m12 5 7 7-7 7"/>
      </svg>
    ),
  },
  order_paid: {
    bg: "bg-emerald-100 dark:bg-emerald-500/15",
    text: "text-emerald-700 dark:text-emerald-300",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="1" x2="12" y2="23"/>
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
      </svg>
    ),
  },
  order_cancelled: {
    bg: "bg-rose-100 dark:bg-rose-500/15",
    text: "text-rose-700 dark:text-rose-300",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="15" y1="9" x2="9" y2="15"/>
        <line x1="9" y1="9" x2="15" y2="15"/>
      </svg>
    ),
  },
  task_created: {
    bg: "bg-blue-100 dark:bg-blue-500/15",
    text: "text-blue-700 dark:text-blue-300",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2"/>
        <line x1="9" y1="10" x2="15" y2="10"/>
      </svg>
    ),
  },
  task_completed: {
    bg: "bg-emerald-100 dark:bg-emerald-500/15",
    text: "text-emerald-700 dark:text-emerald-300",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    ),
  },
  lead_message: {
    bg: "bg-amber-100 dark:bg-amber-500/15",
    text: "text-amber-700 dark:text-amber-300",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        <path d="M8 9h8"/>
        <path d="M8 13h5"/>
      </svg>
    ),
  },
  manual_note: {
    bg: "bg-sky-100 dark:bg-sky-500/15",
    text: "text-sky-700 dark:text-sky-300",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    ),
  },
  reassignment: {
    bg: "bg-violet-100 dark:bg-violet-500/15",
    text: "text-violet-700 dark:text-violet-300",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 1l4 4-4 4"/>
        <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
        <path d="M7 23l-4-4 4-4"/>
        <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
      </svg>
    ),
  },
  contact_edited: {
    bg: "bg-violet-100 dark:bg-violet-500/15",
    text: "text-violet-700 dark:text-violet-300",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9"/>
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
      </svg>
    ),
  },
  contact_created_in_shopify: {
    bg: "bg-emerald-100 dark:bg-emerald-500/15",
    text: "text-emerald-700 dark:text-emerald-300",
    icon: <ShoppingIcon />,
  },
  contact_matched_in_shopify: {
    bg: "bg-emerald-100 dark:bg-emerald-500/15",
    text: "text-emerald-700 dark:text-emerald-300",
    icon: <ShoppingIcon />,
  },
  contact_created_in_whaapy: {
    bg: "bg-sky-100 dark:bg-sky-500/15",
    text: "text-sky-700 dark:text-sky-300",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
      </svg>
    ),
  },
  opportunity_auto_created: {
    bg: "bg-amber-100 dark:bg-amber-500/15",
    text: "text-amber-700 dark:text-amber-300",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
      </svg>
    ),
  },
  other_activity: {
    bg: "bg-gray-100 dark:bg-gray-700",
    text: "text-gray-600 dark:text-gray-300",
    icon: <DotIcon />,
  },
  other_audit: {
    bg: "bg-gray-100 dark:bg-gray-700",
    text: "text-gray-600 dark:text-gray-300",
    icon: <DotIcon />,
  },
};

function ShoppingIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/>
      <line x1="3" y1="6" x2="21" y2="6"/>
      <path d="M16 10a4 4 0 0 1-8 0"/>
    </svg>
  );
}

function DotIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="4"/>
    </svg>
  );
}
