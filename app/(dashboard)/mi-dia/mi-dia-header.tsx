"use client";
import type { MiDiaData } from "@/lib/services/mi-dia";

/**
 * Banda de indicadores de Mi Día. 4 tiles que dan el snapshot del día.
 * Color con significado: rojo SOLO si hay atrasadas (>0); verde para el
 * logro (completadas hoy). Mobile: grid 2×2.
 */
export function MiDiaHeader({ indicators }: { indicators: MiDiaData["indicators"] }) {
  const hasOverdue = indicators.overdue > 0;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile
        label="Atrasadas"
        value={indicators.overdue}
        tone={hasOverdue ? "danger" : "muted"}
      />
      <Tile label="Hoy" value={indicators.today} tone="neutral" />
      <Tile
        label="Pipeline en juego"
        value={indicators.pipelineAtStakeLabel ?? "—"}
        tone="neutral"
      />
      <Tile label="Completadas hoy" value={indicators.completedToday} tone="success" />
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: "danger" | "neutral" | "success" | "muted";
}) {
  const toneCls = {
    danger:
      "border-rose-200 bg-rose-50 dark:border-rose-900/50 dark:bg-rose-900/20",
    success:
      "border-emerald-200 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-900/20",
    neutral: "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800",
    muted: "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/60",
  }[tone];
  const valueCls = {
    danger: "text-rose-700 dark:text-rose-300",
    success: "text-emerald-700 dark:text-emerald-300",
    neutral: "text-slate-900 dark:text-slate-100",
    muted: "text-slate-400 dark:text-slate-500",
  }[tone];
  return (
    <div className={`rounded-xl border p-4 ${toneCls}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${valueCls}`}>{value}</p>
    </div>
  );
}
