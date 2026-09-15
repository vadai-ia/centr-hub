"use client";
import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import type { DashboardGoalsView } from "@/lib/actions/dashboard-goals";
import type { GoalProgress } from "@/lib/services/goal-progress";
import { GoalProgressBar } from "@/components/metas/goal-progress-bar";
import { CloseRateBar } from "@/components/metas/close-rate-bar";
import type { CloseRate } from "@/lib/metas/achievement";
import {
  formatGoalValueShort,
  EDITABLE_GOAL_METRICS,
  GOAL_METRIC_SHORT,
  type GoalMetric,
} from "@/lib/metas/schema";
import type { GoalThresholds } from "@/lib/metas/semaphore";
import { monthLabel } from "@/lib/time/period";

/**
 * Sección "Metas del mes" del Dashboard (M2v2 — Bloque 4, rework). Avance del
 * MES EN CURSO, no responde al filtro de periodo. Layout de COMPARACIÓN:
 * columnas = las métricas con meta + el % de cierre automático (sin objetivo:
 * de sus cotizaciones del mes, cuántas ya se pagaron), alineadas para comparar
 * de un vistazo; filas =
 * sujetos (Equipo + vendedores seleccionados). El admin arranca viendo solo
 * Equipo y agrega vendedores con los chips. El vendedor ve solo su fila.
 */

interface Subject {
  key: string;
  label: string;
  color: string | null;
  byMetric: Map<GoalMetric, GoalProgress>;
  /** null = no aplica (la venta orgánica no cotiza). */
  closeRate: CloseRate | null;
}

function buildByMetric(goals: GoalProgress[]): Map<GoalMetric, GoalProgress> {
  return new Map(goals.map((g) => [g.metric, g]));
}

export function DashboardGoals({ view }: { view: DashboardGoalsView }) {
  const monthKey = view.data.monthKey;
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <div className="mb-4 flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
          Metas del mes
        </h2>
        <span className="text-xs capitalize text-slate-400 dark:text-slate-500">
          {monthLabel(monthKey)} · no cambia con el filtro de periodo
        </span>
      </div>
      {view.isAdmin ? (
        <AdminGoals data={view.data} />
      ) : (
        <VendorGoals
          goals={view.data.goals}
          closeRate={view.data.closeRate}
          thresholds={view.data.thresholds}
        />
      )}
    </section>
  );
}

function AdminGoals({
  data,
}: {
  data: Extract<DashboardGoalsView, { isAdmin: true }>["data"];
}) {
  const subjects = useMemo<Subject[]>(() => {
    const list: Subject[] = [];
    // El equipo va siempre: aunque no tenga metas, su % de cierre existe.
    list.push({
      key: "team",
      label: "Equipo",
      color: null,
      byMetric: buildByMetric(data.team),
      closeRate: data.teamCloseRate,
    });
    // La venta orgánica va JUNTO a los vendedores, no dentro del equipo: es
    // una cubeta más del reparto de la meta mensual ("de los 7 millones, 1 es
    // orgánico"), y verla al lado de cada persona es justo el desglose que
    // permite saber si el total va a cerrar.
    if (data.organic.length > 0) {
      list.push({
        key: "organic",
        label: "Venta orgánica",
        color: null,
        byMetric: buildByMetric(data.organic),
        closeRate: null,
      });
    }
    // byVendor ya trae solo a quien tiene meta o cotizaciones en el mes.
    for (const v of data.byVendor) {
      list.push({
        key: v.membershipId,
        label: v.name,
        color: v.color,
        byMetric: buildByMetric(v.goals),
        closeRate: v.closeRate,
      });
    }
    return list;
  }, [data]);

  // Default: solo el primer sujeto (Equipo si existe).
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(subjects.length > 0 ? [subjects[0].key] : []),
  );

  if (subjects.length === 0) {
    return (
      <p className="text-sm text-slate-400 dark:text-slate-500">
        No hay metas configuradas.{" "}
        <Link href="/admin/metas" className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
          Definir metas
        </Link>
        .
      </p>
    );
  }

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const shown = subjects.filter((s) => selected.has(s.key));

  return (
    <div className="space-y-4">
      {/* Selector de sujetos a comparar */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-400 dark:text-slate-500">Comparar:</span>
        {subjects.map((s) => {
          const on = selected.has(s.key);
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => toggle(s.key)}
              aria-pressed={on}
              className={[
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                on
                  ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/50 dark:bg-indigo-950/40 dark:text-indigo-300"
                  : "border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-700/50",
              ].join(" ")}
            >
              {s.color && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} aria-hidden />}
              {s.label}
            </button>
          );
        })}
      </div>

      {shown.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          Selecciona el equipo o un vendedor para ver el avance.
        </p>
      ) : (
        <ComparisonGrid subjects={shown} thresholds={data.thresholds} showLabels />
      )}
    </div>
  );
}

function VendorGoals({
  goals,
  closeRate,
  thresholds,
}: {
  goals: GoalProgress[];
  closeRate: CloseRate;
  thresholds: GoalThresholds;
}) {
  // Sin metas igual se muestra la fila: el % de cierre no depende de ellas.
  const subject: Subject = {
    key: "me",
    label: "",
    color: null,
    byMetric: buildByMetric(goals),
    closeRate,
  };
  return <ComparisonGrid subjects={[subject]} thresholds={thresholds} showLabels={false} />;
}

/**
 * Grid de comparación: una columna por métrica (alineadas verticalmente para
 * comparar el mismo KPI entre sujetos), una fila por sujeto. Scroll horizontal
 * en pantallas angostas.
 */
function ComparisonGrid({
  subjects,
  thresholds,
  showLabels,
}: {
  subjects: Subject[];
  thresholds: GoalThresholds;
  showLabels: boolean;
}) {
  // Una columna por métrica con meta + la del % de cierre automático.
  const colCount = EDITABLE_GOAL_METRICS.length + 1;
  const cols = showLabels
    ? `minmax(72px,auto) repeat(${colCount}, minmax(120px,1fr))`
    : `repeat(${colCount}, minmax(120px,1fr))`;
  return (
    <div className="overflow-x-auto">
      <div className="grid items-center gap-x-5 gap-y-3" style={{ gridTemplateColumns: cols }}>
        {/* Encabezado de columnas (métricas) */}
        {showLabels && <div />}
        {EDITABLE_GOAL_METRICS.map((m) => (
          <div
            key={`h-${m}`}
            className="text-xs font-semibold text-slate-500 dark:text-slate-400"
          >
            {GOAL_METRIC_SHORT[m]}
          </div>
        ))}
        <div
          className="text-xs font-semibold text-slate-500 dark:text-slate-400"
          title="Se calcula solo: de las cotizaciones del mes, cuántas ya se pagaron."
        >
          % cierre (pagadas / cotizaciones)
        </div>

        {/* Una fila por sujeto */}
        {subjects.map((s) => (
          <Fragment key={s.key}>
            {showLabels && (
              <div className="flex items-center gap-1.5 text-sm font-medium text-slate-700 dark:text-slate-200">
                {s.color && (
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} aria-hidden />
                )}
                <span className="truncate">{s.label}</span>
              </div>
            )}
            {EDITABLE_GOAL_METRICS.map((m) => (
              <MetricCell key={`${s.key}-${m}`} goal={s.byMetric.get(m) ?? null} metric={m} thresholds={thresholds} />
            ))}
            {s.closeRate ? (
              <CloseRateBar rate={s.closeRate} size="sm" compact />
            ) : (
              <span
                className="text-xs text-slate-300 dark:text-slate-600"
                title="La venta orgánica no lleva cotizaciones."
              >
                —
              </span>
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function MetricCell({
  goal,
  metric,
  thresholds,
}: {
  goal: GoalProgress | null;
  metric: GoalMetric;
  thresholds: GoalThresholds;
}) {
  if (!goal) {
    return <span className="text-xs text-slate-300 dark:text-slate-600">— sin meta —</span>;
  }
  return (
    <GoalProgressBar
      pct={goal.pct}
      thresholds={thresholds}
      valueLabel={`${formatGoalValueShort(metric, goal.achieved)} / ${formatGoalValueShort(metric, goal.target)}`}
      size="sm"
      showStatus={false}
    />
  );
}
