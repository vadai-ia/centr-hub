import type { ReactNode } from "react";

type Accent = "default" | "revenue" | "won" | "lost" | "pipeline";

const ACCENT_BAR: Record<Accent, string> = {
  default: "bg-gray-300 dark:bg-gray-600",
  revenue: "bg-emerald-500",
  won: "bg-emerald-500",
  lost: "bg-rose-500",
  pipeline: "bg-indigo-500",
};

interface KpiCardProps {
  label: string;
  value: ReactNode;
  /** Línea secundaria opcional (contexto, ej. "23 ganadas / 7 perdidas"). */
  hint?: ReactNode;
  accent?: Accent;
  /** Card destacada (KPIs principales) — ocupa más alto y texto mayor. */
  emphasis?: boolean;
}

/**
 * Tarjeta de KPI presentacional (M8.2). Jerarquía visual: una barra de
 * acento a la izquierda con color con propósito (verde = bueno/revenue,
 * rojo = pérdidas, índigo = pipeline) y el valor como elemento dominante.
 */
export function KpiCard({ label, value, hint, accent = "default", emphasis = false }: KpiCardProps) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
      <div className={`absolute inset-y-0 left-0 w-1 ${ACCENT_BAR[accent]}`} aria-hidden />
      <div className={emphasis ? "p-5 pl-6" : "p-4 pl-5"}>
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {label}
        </p>
        <p
          className={`mt-1 font-semibold text-gray-900 dark:text-gray-50 tabular-nums ${
            emphasis ? "text-3xl" : "text-2xl"
          }`}
        >
          {value}
        </p>
        {hint ? (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}
