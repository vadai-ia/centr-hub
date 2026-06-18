"use client";
import { useMemo, useState } from "react";
import {
  saveThresholdsAction,
  type AdminMetasData,
  type MetaGoalView,
  type MetaHistoryRow,
} from "@/lib/actions/admin-metas";
import {
  GOAL_METRICS,
  GOAL_METRIC_LABELS,
  formatGoalValue,
  type GoalMetric,
} from "@/lib/metas/schema";
import type { GoalThresholds } from "@/lib/metas/semaphore";
import type { UUID } from "@/lib/types/database";
import { GoalProgressBar } from "@/components/metas/goal-progress-bar";
import { GoalEditModal } from "./goal-edit-modal";

interface Props {
  initialData: AdminMetasData;
}

interface Subject {
  key: string; // "team" | membershipId
  advisorMembershipId: UUID | null;
  label: string;
}

/** Clave de lookup de una meta por sujeto + métrica. */
function goalKey(advisorMembershipId: UUID | null, metric: GoalMetric): string {
  return `${advisorMembershipId ?? "team"}:${metric}`;
}

export function MetasScreen({ initialData }: Props) {
  const [goals, setGoals] = useState<MetaGoalView[]>(initialData.goals);
  const [thresholds, setThresholds] = useState<GoalThresholds>(initialData.thresholds);
  const [banner, setBanner] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [modal, setModal] = useState<{
    metric: GoalMetric;
    advisorMembershipId: UUID | null;
    subjectLabel: string;
    existing: MetaGoalView | null;
  } | null>(null);

  const subjects: Subject[] = useMemo(
    () => [
      { key: "team", advisorMembershipId: null, label: "Equipo (general)" },
      ...initialData.vendors.map((v) => ({
        key: v.membershipId,
        advisorMembershipId: v.membershipId,
        label: v.name,
      })),
    ],
    [initialData.vendors],
  );

  const goalByKey = useMemo(() => {
    const m = new Map<string, MetaGoalView>();
    for (const g of goals) m.set(goalKey(g.advisorMembershipId, g.metric), g);
    return m;
  }, [goals]);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Metas</h1>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          Define las metas mensuales del equipo y de cada vendedor, y los umbrales del semáforo. El
          avance se mide sobre el mes en curso y se reinicia el día 1.
        </p>
      </header>

      {banner && (
        <div
          className={[
            "rounded-xl px-4 py-2.5 text-sm font-medium",
            banner.tone === "error"
              ? "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"
              : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
          ].join(" ")}
        >
          {banner.text}
        </div>
      )}

      <ThresholdsCard
        thresholds={thresholds}
        onSaved={(t) => {
          setThresholds(t);
          setBanner({ tone: "success", text: "Umbrales guardados." });
        }}
        onError={(text) => setBanner({ tone: "error", text })}
      />

      {/* Metas por sujeto + métrica */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
          Metas mensuales
        </h2>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          Toca una celda para definir o editar el objetivo. La meta de equipo se compara contra los
          totales de la operación; cada vendedor contra lo suyo.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left dark:border-slate-700">
                <th className="py-2 pr-3 font-medium text-slate-500 dark:text-slate-400">Sujeto</th>
                {GOAL_METRICS.map((m) => (
                  <th key={m} className="px-3 py-2 font-medium text-slate-500 dark:text-slate-400">
                    {GOAL_METRIC_LABELS[m]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {subjects.map((s) => (
                <tr key={s.key} className="border-b border-slate-100 last:border-0 dark:border-slate-700/50">
                  <td className="py-2 pr-3 font-medium text-slate-700 dark:text-slate-200">{s.label}</td>
                  {GOAL_METRICS.map((m) => {
                    const g = goalByKey.get(goalKey(s.advisorMembershipId, m)) ?? null;
                    return (
                      <td key={m} className="px-3 py-2">
                        <GoalCell
                          goal={g}
                          metric={m}
                          onClick={() =>
                            setModal({
                              metric: m,
                              advisorMembershipId: s.advisorMembershipId,
                              subjectLabel: s.label,
                              existing: g,
                            })
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <HistorySection history={initialData.history} thresholds={thresholds} />

      {modal && (
        <GoalEditModal
          open
          metric={modal.metric}
          subjectLabel={modal.subjectLabel}
          advisorMembershipId={modal.advisorMembershipId}
          existing={modal.existing}
          onClose={() => setModal(null)}
          onSaved={(next) => {
            setGoals(next);
            setBanner({ tone: "success", text: "Meta guardada." });
          }}
        />
      )}
    </div>
  );
}

function GoalCell({
  goal,
  metric,
  onClick,
}: {
  goal: MetaGoalView | null;
  metric: GoalMetric;
  onClick: () => void;
}) {
  if (!goal) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="rounded-lg border border-dashed border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-400 transition-colors hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-600 dark:hover:border-indigo-500"
      >
        + Definir
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded-lg px-2.5 py-1 text-sm transition-colors hover:bg-slate-100 dark:hover:bg-slate-700/60"
    >
      <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">
        {formatGoalValue(metric, goal.targetValue)}
      </span>
      <span
        className={[
          "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
          goal.isActive
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
            : "bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400",
        ].join(" ")}
      >
        {goal.isActive ? "activa" : "inactiva"}
      </span>
    </button>
  );
}

function ThresholdsCard({
  thresholds,
  onSaved,
  onError,
}: {
  thresholds: GoalThresholds;
  onSaved: (t: GoalThresholds) => void;
  onError: (text: string) => void;
}) {
  const [green, setGreen] = useState(String(thresholds.greenPct));
  const [yellow, setYellow] = useState(String(thresholds.yellowPct));
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const res = await saveThresholdsAction({ greenPct: green, yellowPct: yellow });
    setSaving(false);
    if (!res.ok) {
      onError(res.message);
      return;
    }
    setGreen(String(res.thresholds.greenPct));
    setYellow(String(res.thresholds.yellowPct));
    onSaved(res.thresholds);
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
        Umbrales del semáforo
      </h2>
      <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
        Porcentajes de avance donde la barra cambia de color. Aplican igual a las tres métricas.
        Superar el 100% siempre es dorado.
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="text-sm">
          <span className="block font-medium text-slate-700 dark:text-slate-200">Verde desde (%)</span>
          <input
            type="number"
            min={0}
            max={100}
            value={green}
            onChange={(e) => setGreen(e.target.value)}
            className="mt-1 w-28 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
        </label>
        <label className="text-sm">
          <span className="block font-medium text-slate-700 dark:text-slate-200">Amarillo desde (%)</span>
          <input
            type="number"
            min={0}
            max={100}
            value={yellow}
            onChange={(e) => setYellow(e.target.value)}
            className="mt-1 w-28 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
        </label>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? "Guardando…" : "Guardar umbrales"}
        </button>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
        <ZoneChip className="bg-rose-500" label={`Rojo <${thresholds.yellowPct}%`} />
        <ZoneChip
          className="bg-amber-400"
          label={`Amarillo ${thresholds.yellowPct}–${thresholds.greenPct - 1}%`}
        />
        <ZoneChip className="bg-emerald-500" label={`Verde ≥${thresholds.greenPct}%`} />
        <ZoneChip className="bg-gradient-to-r from-amber-300 to-amber-500" label="Dorado >100%" />
      </div>
    </section>
  );
}

function ZoneChip({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-1 font-medium text-slate-600 dark:bg-slate-700/60 dark:text-slate-300">
      <span className={`h-2.5 w-2.5 rounded-full ${className}`} />
      {label}
    </span>
  );
}

function sortSubjects(a: MetaHistoryRow, b: MetaHistoryRow): number {
  // Equipo (advisor null) primero; luego alfabético por nombre.
  if (a.advisorMembershipId === null && b.advisorMembershipId !== null) return -1;
  if (a.advisorMembershipId !== null && b.advisorMembershipId === null) return 1;
  return a.advisorName.localeCompare(b.advisorName);
}

function HistorySection({
  history,
  thresholds,
}: {
  history: MetaHistoryRow[];
  thresholds: GoalThresholds;
}) {
  // Meses disponibles (clave + label), más reciente primero.
  const months = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of history) if (!seen.has(r.monthKey)) seen.set(r.monthKey, r.monthLabel);
    return Array.from(seen.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, label]) => ({ key, label }));
  }, [history]);

  const byMonth = useMemo(() => {
    const map = new Map<string, MetaHistoryRow[]>();
    for (const r of history) {
      const arr = map.get(r.monthKey) ?? [];
      arr.push(r);
      map.set(r.monthKey, arr);
    }
    return map;
  }, [history]);

  // Default: ningún mes expandido (con muchos meses, mostrarlos todos sería interminable).
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
          Histórico mensual
        </h2>
        {months.length > 0 && (
          <MonthSelect months={months} selected={selected} onToggle={toggle} />
        )}
      </div>

      {months.length === 0 ? (
        <p className="mt-3 text-sm text-slate-400 dark:text-slate-500">
          Aún no hay histórico. El resultado de cada meta se guarda automáticamente al cerrar el mes.
        </p>
      ) : selected.size === 0 ? (
        <p className="mt-3 text-sm text-slate-400 dark:text-slate-500">
          Selecciona uno o más meses para ver el histórico.
        </p>
      ) : (
        <div className="mt-4 space-y-7">
          {months
            .filter((m) => selected.has(m.key))
            .map((m) => (
              <MonthHistory
                key={m.key}
                label={m.label}
                rows={byMonth.get(m.key) ?? []}
                thresholds={thresholds}
              />
            ))}
        </div>
      )}
    </section>
  );
}

function MonthSelect({
  months,
  selected,
  onToggle,
}: {
  months: { key: string; label: string }[];
  selected: Set<string>;
  onToggle: (key: string) => void;
}) {
  const count = selected.size;
  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700/50">
        {count === 0 ? "Elegir meses" : `${count} ${count === 1 ? "mes" : "meses"}`}
        <span className="text-slate-400" aria-hidden>▾</span>
      </summary>
      <div className="absolute right-0 z-20 mt-1 max-h-64 w-52 overflow-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg dark:border-slate-700 dark:bg-slate-800">
        {months.map((m) => (
          <label
            key={m.key}
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm capitalize text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700/50"
          >
            <input
              type="checkbox"
              checked={selected.has(m.key)}
              onChange={() => onToggle(m.key)}
              className="accent-indigo-600"
            />
            {m.label}
          </label>
        ))}
      </div>
    </details>
  );
}

function MonthHistory({
  label,
  rows,
  thresholds,
}: {
  label: string;
  rows: MetaHistoryRow[];
  thresholds: GoalThresholds;
}) {
  // Solo las métricas con datos en el mes, en el orden canónico.
  const metrics = GOAL_METRICS.filter((m) => rows.some((r) => r.metric === m));
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold capitalize text-slate-700 dark:text-slate-200">
        {label}
      </h3>
      <div className="space-y-5">
        {metrics.map((m) => {
          const subjectRows = rows.filter((r) => r.metric === m).sort(sortSubjects);
          return (
            <div key={m}>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                {GOAL_METRIC_LABELS[m]}
              </h4>
              <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                {subjectRows.map((r) => (
                  <GoalProgressBar
                    key={r.id}
                    pct={r.pct}
                    thresholds={thresholds}
                    title={r.advisorName}
                    valueLabel={`${formatGoalValue(m, r.achieved)} / ${formatGoalValue(m, r.target)}`}
                    size="sm"
                    showStatus={false}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
