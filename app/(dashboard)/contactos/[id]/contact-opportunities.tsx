"use client";
import Link from "next/link";
import type { ContactOpportunityListItem } from "@/lib/db/contacts-detail";
import type { AdvisorOption } from "@/lib/actions/contacts";
import { effectiveAmount, formatAmount } from "@/lib/format/money";
import { resolveAdvisor } from "../utils";

interface Props {
  venta: ContactOpportunityListItem[];
  postVenta: ContactOpportunityListItem[];
  advisors: AdvisorOption[];
}

/**
 * Listas de oportunidades del contacto, una por funnel (M6 — B3).
 *
 * Cada card se renderiza como Link a `?opp=<id>` — la URL hash que
 * B4 va a interpretar para abrir el popup global. De esa forma B3
 * no necesita re-tocar al conectar B4/B5.
 *
 * Las canceladas se muestran al final de cada funnel con badge
 * "Cancelada" — la doctrina las separa de las perdidas (R5).
 */
export function ContactOpportunities({ venta, postVenta, advisors }: Props) {
  return (
    <div className="space-y-4">
      <FunnelSection
        title="Funnel Venta"
        items={venta}
        advisors={advisors}
        emptyHint="Sin oportunidades en Funnel Venta todavía."
      />
      <FunnelSection
        title="Funnel Post-venta"
        items={postVenta}
        advisors={advisors}
        emptyHint="Sin oportunidades en Funnel Post-venta."
      />
    </div>
  );
}

function FunnelSection({
  title,
  items,
  advisors,
  emptyHint,
}: {
  title: string;
  items: ContactOpportunityListItem[];
  advisors: AdvisorOption[];
  emptyHint: string;
}) {
  const active = items.filter((o) => o.cancelled_at === null);
  const cancelled = items.filter((o) => o.cancelled_at !== null);

  return (
    <section className="bg-white dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700">
      <header className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
          {title}
        </h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">
          {active.length} activa{active.length === 1 ? "" : "s"}
          {cancelled.length > 0 ? ` · ${cancelled.length} cancelada${cancelled.length === 1 ? "" : "s"}` : ""}
        </span>
      </header>

      {items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-gray-400 dark:text-gray-500 text-center italic">
          {emptyHint}
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-700">
          {active.map((opp) => (
            <OpportunityCard key={opp.id} opp={opp} advisors={advisors} />
          ))}
          {cancelled.map((opp) => (
            <OpportunityCard key={opp.id} opp={opp} advisors={advisors} isCancelled />
          ))}
        </ul>
      )}
    </section>
  );
}

function OpportunityCard({
  opp,
  advisors,
  isCancelled,
}: {
  opp: ContactOpportunityListItem;
  advisors: AdvisorOption[];
  isCancelled?: boolean;
}) {
  const amount = effectiveAmount(opp);
  const moneyText = formatAmount(amount.value, opp.currency);
  const advisor = resolveAdvisor(opp.assigned_advisor_id, advisors);

  return (
    <li>
      <Link
        href={`?opp=${opp.id}`}
        scroll={false}
        className={[
          "block px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/40 transition-colors",
          isCancelled ? "opacity-60" : "",
        ].join(" ")}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: opp.stage_color }}
                aria-hidden
              />
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                {opp.stage_name}
              </span>
              {opp.display_reference && (
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {opp.display_reference}
                </span>
              )}
              {isCancelled && (
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                  Cancelada
                </span>
              )}
              {opp.stage_is_won && (
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                  Ganada
                </span>
              )}
              {opp.stage_is_lost && (
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
                  Perdida
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 dark:text-gray-400">
              <span className="flex items-center gap-1">
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: advisor.color }}
                />
                {advisor.fullName}
              </span>
              {opp.invoice_url && (
                <span className="text-indigo-600 dark:text-indigo-300">
                  Cobro disponible
                </span>
              )}
            </div>
          </div>
          <span
            className={[
              "text-sm font-semibold tabular-nums flex-shrink-0",
              amount.value === null
                ? "text-gray-400 dark:text-gray-500 italic"
                : amount.isEstimated
                  ? "text-amber-700 dark:text-amber-300"
                  : "text-gray-900 dark:text-gray-100",
            ].join(" ")}
          >
            {moneyText ?? "Sin monto"}
          </span>
        </div>
      </Link>
    </li>
  );
}
