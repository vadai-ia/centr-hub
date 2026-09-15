"use client";
import { useEffect, useState } from "react";
import { loadCloseRatesForMonthAction } from "@/lib/actions/admin-metas";
import type { CloseRateRow } from "@/lib/services/goal-progress";
import { CloseRateBar } from "@/components/metas/close-rate-bar";

/**
 * % de cierre de cotizaciones de un mes en "Avance por mes". No se captura: de
 * las cotizaciones hechas en el mes, cuántas ya se pagaron. El mes en curso
 * llega ya calculado; un mes cerrado se pide al abrirlo (se recalcula de los
 * datos por cohorte, no hay snapshot que leer).
 */

type State =
  | { status: "ready"; rows: CloseRateRow[] }
  | { status: "loading" }
  | { status: "error"; message: string };

export function MonthCloseRate({
  monthKey,
  initialRows,
}: {
  monthKey: string;
  initialRows: CloseRateRow[] | null;
}) {
  const [state, setState] = useState<State>(
    initialRows ? { status: "ready", rows: initialRows } : { status: "loading" },
  );

  useEffect(() => {
    if (initialRows) return;
    let cancelled = false;
    setState({ status: "loading" });
    loadCloseRatesForMonthAction(monthKey)
      .then((res) => {
        if (cancelled) return;
        setState(res.ok ? { status: "ready", rows: res.rows } : { status: "error", message: res.message });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", message: "No se pudo calcular el % de cierre." });
      });
    return () => {
      cancelled = true;
    };
  }, [monthKey, initialRows]);

  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
        % de cierre de cotizaciones
      </h4>
      <p className="mb-2 mt-0.5 text-xs text-slate-400 dark:text-slate-500">
        Se calcula solo: de las cotizaciones hechas en el mes, cuántas ya se pagaron.
      </p>
      {state.status === "loading" ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">Calculando…</p>
      ) : state.status === "error" ? (
        <p className="text-sm text-rose-600 dark:text-rose-400">{state.message}</p>
      ) : (
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {sortRows(state.rows).map((r) => (
            <CloseRateBar key={r.key} rate={r.closeRate} title={r.name} size="sm" />
          ))}
        </div>
      )}
    </div>
  );
}

/** Equipo primero, luego vendedores por nombre (mismo orden que las metas). */
function sortRows(rows: CloseRateRow[]): CloseRateRow[] {
  return [...rows].sort((a, b) => {
    if (a.subject !== b.subject) return a.subject === "team" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
