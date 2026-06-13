"use client";
import { useState, useTransition } from "react";
import type { MiDiaAdminExtras, MiDiaUnassignedCard } from "@/lib/services/mi-dia-admin";
import { assignOpportunityAction } from "@/lib/actions/mi-dia-admin";

/**
 * Oportunidades sin asignar (Mi Día admin, Bloque C). El admin las toma
 * o las asigna a un vendedor desde aquí. La asignación reusa el núcleo
 * "marcado como manual" — la reconciliación horaria no la pisa.
 */
export function MiDiaUnassigned({
  cards,
  vendors,
  onView,
  onAssigned,
}: {
  cards: MiDiaUnassignedCard[];
  vendors: MiDiaAdminExtras["vendors"];
  onView: (oppId: string) => void;
  onAssigned: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (cards.length === 0) return null;

  return (
    <section className="rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-amber-50/30 p-4 shadow-sm dark:border-amber-900/40 dark:from-amber-900/15 dark:to-amber-900/5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 text-left text-sm font-semibold text-amber-800 dark:text-amber-300"
      >
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        Oportunidades sin asignar
        <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
          {cards.length}
        </span>
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          {cards.map((card) => (
            <UnassignedRow
              key={card.opportunityId}
              card={card}
              vendors={vendors}
              onView={onView}
              onAssigned={onAssigned}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function UnassignedRow({
  card,
  vendors,
  onView,
  onAssigned,
}: {
  card: MiDiaUnassignedCard;
  vendors: MiDiaAdminExtras["vendors"];
  onView: (oppId: string) => void;
  onAssigned: () => void;
}) {
  const [sel, setSel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function assign() {
    if (!sel) return;
    setError(null);
    startTransition(async () => {
      const res = await assignOpportunityAction({
        opportunityId: card.opportunityId,
        membershipId: sel,
      });
      if (res.ok) onAssigned();
      else setError(res.message);
    });
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
              {card.contactName ?? "Sin nombre"}
            </span>
            {card.displayReference && (
              <span className="text-xs text-slate-400">{card.displayReference}</span>
            )}
          </div>
          {card.stageName && (
            <div className="mt-0.5 flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: card.stageColor ?? "#94A3B8" }}
              />
              <span className="text-xs text-slate-500 dark:text-slate-400">{card.stageName}</span>
            </div>
          )}
        </div>
        {card.amountLabel && (
          <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {card.amountLabel}
          </span>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <select
          value={sel}
          onChange={(e) => setSel(e.target.value)}
          disabled={pending}
          className="flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-600 dark:bg-slate-900"
        >
          <option value="">Asignar a…</option>
          {vendors.map((v) => (
            <option key={v.membershipId} value={v.membershipId}>
              {v.name ?? "Vendedor"}
            </option>
          ))}
        </select>
        <button
          onClick={assign}
          disabled={!sel || pending}
          className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          Asignar
        </button>
        <button
          onClick={() => onView(card.opportunityId)}
          className="text-xs text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
        >
          Ver
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
