"use client";
import type { ReactNode } from "react";
import type { MiDiaSilentClient, MiDiaWeekDay } from "@/lib/services/mi-dia";
import type { VendorGoalProgress } from "@/lib/services/goal-progress";
import { GoalEmptyState, GoalProgressBar } from "@/components/metas/goal-progress-bar";
import { formatGoalValueShort, GOAL_METRIC_SHORT } from "@/lib/metas/schema";
import { IconFlame } from "./mi-dia-icons";

const DAY_INITIAL = ["D", "L", "M", "M", "J", "V", "S"];
const STREAK_MILESTONE = 7;

export function MiDiaSidebar({
  silentClients,
  week,
  streak,
  goal,
  showGoal,
  onView,
}: {
  silentClients: MiDiaSilentClient[];
  week: MiDiaWeekDay[];
  streak: number;
  goal: VendorGoalProgress | null;
  /** Solo vendedores ven el widget "Meta del mes" (los admin no son titulares). */
  showGoal: boolean;
  onView: (contactId: string) => void;
}) {
  return (
    <div className="space-y-4">
      {/* Racha — elemento visual destacado (hero del sidebar) */}
      <StreakWidget streak={streak} />

      <Widget title="Clientes silenciosos">
        {silentClients.length === 0 ? (
          <p className="text-xs text-slate-400">Nadie en silencio. Todos al día.</p>
        ) : (
          <ul className="space-y-1.5">
            {silentClients.map((c) => (
              <li
                key={c.contactId}
                className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-slate-50 dark:hover:bg-slate-900/40"
              >
                <button
                  onClick={() => onView(c.contactId)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-sm font-medium text-slate-700 hover:text-indigo-600 dark:text-slate-200">
                    {c.name ?? "Sin nombre"}
                  </span>
                  <span className="text-xs text-slate-400">
                    {c.amountLabel ? `${c.amountLabel} · ` : ""}
                    {c.daysSince === null ? "sin actividad" : `${c.daysSince} días en silencio`}
                  </span>
                </button>
                <button
                  onClick={() => onView(c.contactId)}
                  className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-indigo-950/40"
                >
                  Empujar
                </button>
              </li>
            ))}
          </ul>
        )}
      </Widget>

      <Widget title="Tu semana">
        <WeekHistogram week={week} />
      </Widget>

      {showGoal && (
      <Widget title="Meta del mes">
        {goal && goal.goals.length > 0 ? (
          <div className="space-y-4">
            {goal.goals.map((g) => (
              <GoalProgressBar
                key={g.goalId}
                pct={g.pct}
                thresholds={goal.thresholds}
                title={GOAL_METRIC_SHORT[g.metric]}
                valueLabel={`${formatGoalValueShort(g.metric, g.achieved)} / ${formatGoalValueShort(g.metric, g.target)}`}
                size="sm"
              />
            ))}
          </div>
        ) : (
          <GoalEmptyState hint="Sin meta asignada" size="sm" />
        )}
      </Widget>
      )}
    </div>
  );
}

function StreakWidget({ streak }: { streak: number }) {
  const active = streak > 0;
  const filled = Math.min(streak, STREAK_MILESTONE);
  const pct = Math.min(streak / STREAK_MILESTONE, 1) * 100;
  const hitMilestone = streak >= STREAK_MILESTONE;

  return (
    <section
      className={[
        "relative overflow-hidden rounded-2xl border p-4 shadow-sm",
        active
          ? "border-amber-200/80 bg-gradient-to-br from-amber-50 via-orange-50 to-white dark:border-amber-900/40 dark:from-amber-950/40 dark:via-orange-950/20 dark:to-slate-900"
          : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800",
      ].join(" ")}
    >
      <div className="flex items-center gap-3">
        <div
          className={[
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl",
            active
              ? "bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-md shadow-orange-300/50 dark:shadow-orange-900/40"
              : "bg-slate-100 text-slate-300 dark:bg-slate-700 dark:text-slate-500",
          ].join(" ")}
        >
          <IconFlame className="h-6 w-6" />
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className={`text-2xl font-bold tabular-nums ${active ? "text-orange-600 dark:text-orange-300" : "text-slate-400"}`}>
              {streak}
            </span>
            <span className={`text-sm font-medium ${active ? "text-orange-500/80 dark:text-orange-300/70" : "text-slate-400"}`}>
              {streak === 1 ? "día" : "días"} de racha
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
            {hitMilestone
              ? "¡Semana completa! Sigue así 🔥"
              : active
                ? "Completando pendientes cada día"
                : "Completá una tarea para arrancar"}
          </p>
        </div>
      </div>

      {/* Pips de los últimos días + barra de progreso al hito semanal */}
      <div className="mt-3 flex items-center gap-1.5">
        {Array.from({ length: STREAK_MILESTONE }).map((_, i) => (
          <span
            key={i}
            className={[
              "h-1.5 flex-1 rounded-full transition-colors",
              i < filled
                ? "bg-gradient-to-r from-amber-400 to-orange-500"
                : "bg-slate-200 dark:bg-slate-700",
            ].join(" ")}
            title={`Día ${i + 1}`}
          />
        ))}
      </div>
      {active && !hitMilestone && (
        <p className="mt-1.5 text-[11px] text-slate-400">
          {STREAK_MILESTONE - streak} día{STREAK_MILESTONE - streak === 1 ? "" : "s"} para la semana completa
        </p>
      )}
      {/* franja de progreso continua (refuerza el avance) */}
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div
          className="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </section>
  );
}

function Widget({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

function WeekHistogram({ week }: { week: MiDiaWeekDay[] }) {
  const max = Math.max(1, ...week.map((d) => Math.max(d.created, d.completed)));
  return (
    <div>
      <div className="flex items-end justify-between gap-1.5" style={{ height: 64 }}>
        {week.map((d) => {
          const di = new Date(`${d.dayKey}T12:00:00Z`).getUTCDay();
          return (
            <div key={d.dayKey} className="flex flex-1 flex-col items-center justify-end gap-1">
              <div className="flex h-full w-full items-end justify-center gap-0.5">
                <div
                  className="w-2 rounded-t-md bg-slate-200 dark:bg-slate-600"
                  style={{ height: `${(d.created / max) * 100}%` }}
                  title={`${d.created} creadas`}
                />
                <div
                  className="w-2 rounded-t-md bg-gradient-to-t from-emerald-500 to-emerald-400"
                  style={{ height: `${(d.completed / max) * 100}%` }}
                  title={`${d.completed} completadas`}
                />
              </div>
              <span className="text-[10px] font-medium text-slate-400">{DAY_INITIAL[di]}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-3 text-[10px] text-slate-400">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-emerald-400" /> Completadas
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-slate-300 dark:bg-slate-600" /> Creadas
        </span>
      </div>
    </div>
  );
}
