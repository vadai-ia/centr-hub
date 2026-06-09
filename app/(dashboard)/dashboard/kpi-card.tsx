import type { ReactNode } from "react";
import { InfoTooltip } from "./info-tooltip";

type Accent = "default" | "revenue" | "won" | "lost" | "pipeline";

/**
 * Sistema de color semántico (M8.2 rediseño). El color COMUNICA, no
 * adorna: emerald = positivo/ingreso/ganado, rose = negativo/pérdida,
 * indigo = en curso/pipeline, gris = conteo sin valencia. Los conteos
 * neutros (Leads, Cotizaciones, Sales cycle) quedan en gris a propósito
 * para que el color signifique algo cuando aparece.
 */
const ACCENT: Record<
  Accent,
  { heroBg: string; chip: string; value: string }
> = {
  default: {
    heroBg: "bg-gray-50 border-gray-200 dark:bg-gray-800/60 dark:border-gray-700",
    chip: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
    value: "text-gray-900 dark:text-gray-50",
  },
  revenue: {
    heroBg: "bg-emerald-50/60 border-emerald-200/70 dark:bg-emerald-900/15 dark:border-emerald-800/40",
    chip: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
    value: "text-emerald-700 dark:text-emerald-300",
  },
  won: {
    heroBg: "bg-emerald-50/60 border-emerald-200/70 dark:bg-emerald-900/15 dark:border-emerald-800/40",
    chip: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
    value: "text-emerald-700 dark:text-emerald-300",
  },
  lost: {
    heroBg: "bg-rose-50/60 border-rose-200/70 dark:bg-rose-900/15 dark:border-rose-800/40",
    chip: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
    value: "text-rose-700 dark:text-rose-300",
  },
  pipeline: {
    heroBg: "bg-indigo-50/60 border-indigo-200/70 dark:bg-indigo-900/15 dark:border-indigo-800/40",
    chip: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
    value: "text-indigo-700 dark:text-indigo-300",
  },
};

interface KpiCardProps {
  label: string;
  value: ReactNode;
  /** Línea secundaria opcional (contexto, ej. "17 ganadas · 7 perdidas"). */
  hint?: ReactNode;
  /** Texto estático del tooltip "qué es + cómo se calcula". */
  tooltip?: string;
  accent?: Accent;
  /** Card destacada (KPIs principales): fondo tintado + ícono + valor grande. */
  emphasis?: boolean;
  /** Ícono del chip (solo hero). */
  icon?: ReactNode;
}

/**
 * Tarjeta de KPI presentacional (M8.2 rediseño). Dos jerarquías:
 *  - hero (`emphasis`): fondo tintado del color semántico, chip de ícono
 *    tintado, valor 4xl coloreado. El ojo va aquí primero.
 *  - secundaria: compacta, fondo neutro, valor más chico; el color sólo
 *    tiñe el valor cuando tiene valencia (loss rate rojo, etc.).
 */
export function KpiCard({
  label,
  value,
  hint,
  tooltip,
  accent = "default",
  emphasis = false,
  icon,
}: KpiCardProps) {
  const a = ACCENT[accent];

  if (emphasis) {
    return (
      <div className={`relative rounded-xl border p-4 shadow-sm ${a.heroBg}`}>
        <div className="flex items-start justify-between gap-2">
          <p className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {label}
            {tooltip ? <InfoTooltip label={label} content={tooltip} /> : null}
          </p>
          {icon ? (
            <span
              className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg [&>svg]:h-[18px] [&>svg]:w-[18px] ${a.chip}`}
            >
              {icon}
            </span>
          ) : null}
        </div>
        <p className={`mt-2 text-3xl font-bold tabular-nums sm:text-4xl ${a.value}`}>{value}</p>
        {hint ? (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p>
        ) : null}
      </div>
    );
  }

  // Secundaria — compacta y discreta.
  const valueColor = accent === "default" ? "text-gray-900 dark:text-gray-100" : a.value;
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3.5 py-3 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <p className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
        {tooltip ? <InfoTooltip label={label} content={tooltip} /> : null}
      </p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${valueColor}`}>{value}</p>
      {hint ? (
        <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">{hint}</p>
      ) : null}
    </div>
  );
}
