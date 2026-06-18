"use client";
import { useEffect, useState } from "react";
import {
  deleteGoalAction,
  upsertGoalAction,
  type MetaGoalView,
} from "@/lib/actions/admin-metas";
import { Switch } from "@/components/ui/switch";
import { GOAL_METRIC_HINTS, GOAL_METRIC_LABELS, isCountMetric, type GoalMetric } from "@/lib/metas/schema";
import type { UUID } from "@/lib/types/database";

interface Props {
  open: boolean;
  metric: GoalMetric;
  subjectLabel: string;
  advisorMembershipId: UUID | null; // null = equipo
  existing: MetaGoalView | null;
  onClose: () => void;
  onSaved: (goals: MetaGoalView[]) => void;
}

/**
 * Modal de definir/editar/quitar una meta (M2v2 — Bloque 3). El sujeto
 * (equipo o vendedor) y la métrica vienen fijos desde la celda clicada; acá
 * solo se captura el objetivo mensual y si está activa.
 */
export function GoalEditModal({
  open,
  metric,
  subjectLabel,
  advisorMembershipId,
  existing,
  onClose,
  onSaved,
}: Props) {
  const [target, setTarget] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTarget(existing ? String(existing.targetValue) : "");
    setIsActive(existing ? existing.isActive : true);
    setError(null);
    setSubmitting(false);
  }, [open, existing]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  if (!open) return null;

  const count = isCountMetric(metric);

  async function handleSave() {
    setSubmitting(true);
    setError(null);
    const res = await upsertGoalAction({
      advisorMembershipId,
      metric,
      targetValue: target,
      isActive,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onSaved(res.goals);
    onClose();
  }

  async function handleDelete() {
    if (!existing) return;
    setSubmitting(true);
    setError(null);
    const res = await deleteGoalAction({ id: existing.id });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onSaved(res.goals);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-800">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          {GOAL_METRIC_LABELS[metric]}
        </h2>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          {subjectLabel} · {GOAL_METRIC_HINTS[metric]}
        </p>

        <label className="mt-4 block text-sm font-medium text-slate-700 dark:text-slate-200">
          Objetivo mensual {count ? "(cantidad)" : "(monto)"}
        </label>
        <div className="mt-1 flex items-center gap-2">
          {!count && <span className="text-slate-400">$</span>}
          <input
            type="number"
            min={0}
            step={count ? 1 : 100}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            autoFocus
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            placeholder={count ? "Ej. 20" : "Ej. 80000"}
          />
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div>
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Meta activa</span>
            <p className="text-xs text-slate-400 dark:text-slate-500">
              Inactiva: no se evalúa ni se muestra.
            </p>
          </div>
          <Switch checked={isActive} onChange={() => setIsActive((v) => !v)} ariaLabel="Meta activa" />
        </div>

        {error && (
          <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-600 dark:bg-rose-950/40 dark:text-rose-400">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center justify-between gap-2">
          <div>
            {existing && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={submitting}
                className="rounded-lg px-3 py-2 text-sm font-medium text-rose-600 transition-colors hover:bg-rose-50 disabled:opacity-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
              >
                Quitar meta
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={submitting}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
