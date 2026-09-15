"use client";
import { useEffect, useState } from "react";
import { DateTime } from "luxon";
import {
  loadAmountBreakdownAction,
  type AmountBreakdownResult,
} from "@/lib/actions/admin-metas-breakdown";
import type { MetaHistoryRow } from "@/lib/actions/admin-metas";
import { formatAmount } from "@/lib/format/money";
import { TIMEZONE } from "@/lib/constants";

/**
 * "Ver pedidos" de la meta de monto: la tabla de pedidos pagados que suman el
 * avance de un sujeto en el mes. Cuenta el subtotal (productos con descuento,
 * sin envío); envío y total se muestran solo como referencia.
 */

type State =
  | { status: "loading" }
  | { status: "done"; result: AmountBreakdownResult };

export function AmountBreakdownModal({
  monthKey,
  monthLabel,
  row,
  onClose,
}: {
  monthKey: string;
  monthLabel: string;
  row: MetaHistoryRow;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const input =
      row.subject === "advisor"
        ? { monthKey, subject: row.subject, advisorMembershipId: row.advisorMembershipId }
        : { monthKey, subject: row.subject };
    loadAmountBreakdownAction(input)
      .then((result) => {
        if (!cancelled) setState({ status: "done", result });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "done", result: { ok: false, message: "No se pudieron cargar los pedidos." } });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [monthKey, row]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Pedidos de ${row.advisorName}`}
        className="flex max-h-[85vh] w-full max-w-5xl flex-col rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-800"
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 p-5 dark:border-slate-700">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Monto vendido · {row.advisorName}
            </h2>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              <span className="capitalize">{monthLabel}</span> · pedidos pagados. Cuenta el subtotal:
              productos con descuento, sin envío.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            Cerrar
          </button>
        </header>
        <div className="overflow-auto p-5">
          <Body state={state} row={row} />
        </div>
      </div>
    </div>
  );
}

function Body({ state, row }: { state: State; row: MetaHistoryRow }) {
  if (state.status === "loading") {
    return <p className="text-sm text-slate-400 dark:text-slate-500">Cargando pedidos…</p>;
  }
  if (!state.result.ok) {
    return <p className="text-sm text-rose-600 dark:text-rose-400">{state.result.message}</p>;
  }
  const { rows, totals, currency } = state.result.breakdown;
  if (rows.length === 0) {
    return <p className="text-sm text-slate-400 dark:text-slate-500">No hay pedidos pagados en este mes.</p>;
  }
  const money = (v: number) => formatAmount(v, currency) ?? "—";
  // Un mes cerrado muestra el avance congelado al cierre; si el criterio cambió
  // después, la tabla (calculada hoy) no coincide y hay que decirlo.
  const mismatch = Math.abs(totals.subtotal - row.achieved) > 1;

  return (
    <div className="space-y-3">
      {mismatch && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          La barra muestra {money(row.achieved)}, guardado al cerrar el mes con el criterio de ese
          momento. Esta tabla está calculada hoy con el subtotal.
        </p>
      )}
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
            <th className="py-2 pr-3 font-medium">#</th>
            <th className="py-2 pr-3 font-medium">Pedido</th>
            <th className="py-2 pr-3 font-medium">Fecha</th>
            <th className="py-2 pr-3 font-medium">Cliente</th>
            <th className="py-2 pr-3 text-right font-medium">Productos</th>
            <th className="py-2 pr-3 text-right font-medium">Descuento</th>
            <th className="py-2 pr-3 text-right font-semibold text-slate-700 dark:text-slate-200">Subtotal</th>
            <th className="py-2 pr-3 text-right font-medium">Envío</th>
            <th className="py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((r, i) => (
            <tr key={`${r.orderName}-${i}`} className="border-b border-slate-100 dark:border-slate-700/50">
              <td className="py-2 pr-3 text-slate-400">{i + 1}</td>
              <td className="py-2 pr-3 font-mono text-xs text-slate-600 dark:text-slate-300">{r.orderName}</td>
              <td className="whitespace-nowrap py-2 pr-3 text-slate-500 dark:text-slate-400">
                {r.paidAt
                  ? DateTime.fromISO(r.paidAt, { zone: "utc" }).setZone(TIMEZONE).setLocale("es").toFormat("dd LLL")
                  : "—"}
              </td>
              <td className="py-2 pr-3 text-slate-700 dark:text-slate-200">{r.customer}</td>
              <td className="py-2 pr-3 text-right text-slate-500 dark:text-slate-400">{money(r.products)}</td>
              <td className="py-2 pr-3 text-right text-slate-500 dark:text-slate-400">
                {r.discount > 0 ? `−${money(r.discount)}` : "—"}
              </td>
              <td className="py-2 pr-3 text-right font-semibold text-slate-900 dark:text-slate-50">{money(r.subtotal)}</td>
              <td className="py-2 pr-3 text-right text-slate-400 dark:text-slate-500">{money(r.shipping)}</td>
              <td className="py-2 text-right text-slate-400 dark:text-slate-500">{money(r.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="tabular-nums">
          <tr className="border-t-2 border-slate-200 font-semibold dark:border-slate-600">
            <td className="py-2 pr-3" />
            <td className="py-2 pr-3 text-slate-700 dark:text-slate-200" colSpan={3}>
              Total ({rows.length} {rows.length === 1 ? "pedido" : "pedidos"})
            </td>
            <td className="py-2 pr-3 text-right text-slate-600 dark:text-slate-300">{money(totals.products)}</td>
            <td className="py-2 pr-3 text-right text-slate-600 dark:text-slate-300">−{money(totals.discount)}</td>
            <td className="py-2 pr-3 text-right text-slate-900 dark:text-slate-50">{money(totals.subtotal)}</td>
            <td className="py-2 pr-3 text-right text-slate-500 dark:text-slate-400">{money(totals.shipping)}</td>
            <td className="py-2 text-right text-slate-500 dark:text-slate-400">{money(totals.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
