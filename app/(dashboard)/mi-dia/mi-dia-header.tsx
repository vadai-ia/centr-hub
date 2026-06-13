"use client";
import type { ReactNode } from "react";
import type { MiDiaData } from "@/lib/services/mi-dia";
import { IconAlert, IconSun, IconCoins, IconCheck } from "./mi-dia-icons";

/**
 * Banda de indicadores de Mi Día (rediseño M1v2 correctivo). 4 tiles con
 * jerarquía gráfica real: chip de ícono tintado, fondo con color
 * semántico, valor grande tabular. El color COMUNICA, no decora:
 *   - rose  → atrasadas (sólo tiñe fuerte cuando hay >0; si 0, queda gris)
 *   - indigo→ pipeline en juego (en curso)
 *   - emerald→ completadas hoy (logro)
 *   - slate → "hoy" (conteo neutro)
 * La tile de atrasadas-activas se realza (ring + glow + punto que late)
 * para que el ojo caiga primero en lo urgente. Mobile: grid 2×2.
 */
export function MiDiaHeader({ indicators }: { indicators: MiDiaData["indicators"] }) {
  const hasOverdue = indicators.overdue > 0;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile
        label="Atrasadas"
        value={indicators.overdue}
        tone={hasOverdue ? "danger" : "muted"}
        icon={<IconAlert className="h-[18px] w-[18px]" />}
        alert={hasOverdue}
      />
      <Tile
        label="Hoy"
        value={indicators.today}
        tone="neutral"
        icon={<IconSun className="h-[18px] w-[18px]" />}
      />
      <Tile
        label="Pipeline en juego"
        value={indicators.pipelineAtStakeLabel ?? "—"}
        tone="pipeline"
        icon={<IconCoins className="h-[18px] w-[18px]" />}
      />
      <Tile
        label="Completadas hoy"
        value={indicators.completedToday}
        tone="success"
        icon={<IconCheck className="h-[18px] w-[18px]" />}
      />
    </div>
  );
}

type Tone = "danger" | "neutral" | "success" | "muted" | "pipeline";

const TONE: Record<
  Tone,
  { card: string; chip: string; value: string; label: string }
> = {
  danger: {
    card: "border-rose-200 bg-gradient-to-br from-rose-50 to-white ring-1 ring-rose-200/60 shadow-sm shadow-rose-200/50 dark:border-rose-900/50 dark:from-rose-950/40 dark:to-slate-900 dark:ring-rose-900/40",
    chip: "bg-rose-100 text-rose-600 dark:bg-rose-900/50 dark:text-rose-300",
    value: "text-rose-700 dark:text-rose-300",
    label: "text-rose-600/80 dark:text-rose-300/70",
  },
  pipeline: {
    card: "border-indigo-200/70 bg-gradient-to-br from-indigo-50/70 to-white shadow-sm dark:border-indigo-900/40 dark:from-indigo-950/30 dark:to-slate-900",
    chip: "bg-indigo-100 text-indigo-600 dark:bg-indigo-900/50 dark:text-indigo-300",
    value: "text-indigo-700 dark:text-indigo-300",
    label: "text-slate-500 dark:text-slate-400",
  },
  success: {
    card: "border-emerald-200/70 bg-gradient-to-br from-emerald-50/70 to-white shadow-sm dark:border-emerald-900/40 dark:from-emerald-950/30 dark:to-slate-900",
    chip: "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/50 dark:text-emerald-300",
    value: "text-emerald-700 dark:text-emerald-300",
    label: "text-slate-500 dark:text-slate-400",
  },
  neutral: {
    card: "border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800",
    chip: "bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300",
    value: "text-slate-900 dark:text-slate-100",
    label: "text-slate-500 dark:text-slate-400",
  },
  muted: {
    card: "border-slate-200 bg-slate-50/70 dark:border-slate-700/70 dark:bg-slate-800/50",
    chip: "bg-slate-200/70 text-slate-400 dark:bg-slate-700 dark:text-slate-500",
    value: "text-slate-400 dark:text-slate-500",
    label: "text-slate-400 dark:text-slate-500",
  },
};

function Tile({
  label,
  value,
  tone,
  icon,
  alert = false,
}: {
  label: string;
  value: number | string;
  tone: Tone;
  icon: ReactNode;
  alert?: boolean;
}) {
  const t = TONE[tone];
  return (
    <div className={`relative overflow-hidden rounded-2xl border p-4 transition-shadow ${t.card}`}>
      <div className="flex items-start justify-between gap-2">
        <p className={`text-xs font-semibold uppercase tracking-wide ${t.label}`}>
          {label}
        </p>
        <span
          className={`relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl ${t.chip}`}
        >
          {icon}
          {alert && (
            <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
            </span>
          )}
        </span>
      </div>
      <p className={`mt-2 text-3xl font-bold tabular-nums ${t.value}`}>{value}</p>
    </div>
  );
}
