"use client";
import type { AdvisorOption, DashboardFiltersInput } from "@/lib/actions/dashboard";
import type { Funnel } from "@/lib/types/database";

const PRESET_BUTTONS: Array<{ value: DashboardFiltersInput["preset"]; label: string }> = [
  { value: "today", label: "Hoy" },
  { value: "7d", label: "7 días" },
  { value: "30d", label: "30 días" },
  { value: "90d", label: "90 días" },
];

interface Props {
  filters: DashboardFiltersInput;
  isAdmin: boolean;
  advisors: AdvisorOption[];
  pending: boolean;
  /** Error de validación del rango custom (desde > hasta). */
  customError: string | null;
  onFunnelChange: (f: Funnel) => void;
  onPresetChange: (p: DashboardFiltersInput["preset"]) => void;
  onCustomChange: (from: string, to: string) => void;
  onAdvisorChange: (advisor: string) => void;
  onExport: () => void;
}

export function DashboardToolbar({
  filters,
  isAdmin,
  advisors,
  pending,
  customError,
  onFunnelChange,
  onPresetChange,
  onCustomChange,
  onAdvisorChange,
  onExport,
}: Props) {
  const isCustom = filters.preset === "custom";

  function funnelBtn(value: Funnel, label: string) {
    const active = filters.funnel === value;
    return (
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => onFunnelChange(value)}
        className={`px-3 py-1.5 text-sm rounded transition-colors ${
          active
            ? "bg-indigo-600 text-white shadow-sm"
            : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
        }`}
      >
        {label}
      </button>
    );
  }

  function presetBtn(value: DashboardFiltersInput["preset"], label: string) {
    const active = filters.preset === value;
    return (
      <button
        key={value}
        type="button"
        onClick={() => onPresetChange(value)}
        className={`px-2.5 py-1 text-sm rounded-md border transition-colors ${
          active
            ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-200 font-medium"
            : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/60"
        }`}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Funnel"
          className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-0.5"
        >
          {funnelBtn("venta", "Venta")}
          {funnelBtn("post_venta", "Post-venta")}
        </div>

        <div className="flex items-center gap-2">
          {pending ? (
            <span className="text-xs text-gray-400 dark:text-gray-500 animate-pulse">Actualizando…</span>
          ) : null}
          <button
            type="button"
            onClick={onExport}
            className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 dark:bg-gray-100 px-3 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:opacity-90 transition-opacity"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Exportar
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {PRESET_BUTTONS.map((b) => presetBtn(b.value, b.label))}
          {presetBtn("custom", "Personalizado")}
        </div>

        {isCustom ? (
          <div className="flex items-end gap-2">
            <label className="flex flex-col text-xs text-gray-500 dark:text-gray-400">
              Desde
              <input
                type="date"
                value={filters.customFrom ?? ""}
                max={filters.customTo ?? undefined}
                onChange={(e) => onCustomChange(e.target.value, filters.customTo ?? "")}
                className="mt-0.5 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-sm text-gray-800 dark:text-gray-100"
              />
            </label>
            <label className="flex flex-col text-xs text-gray-500 dark:text-gray-400">
              Hasta
              <input
                type="date"
                value={filters.customTo ?? ""}
                min={filters.customFrom ?? undefined}
                onChange={(e) => onCustomChange(filters.customFrom ?? "", e.target.value)}
                className="mt-0.5 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-sm text-gray-800 dark:text-gray-100"
              />
            </label>
          </div>
        ) : null}

        {isAdmin ? (
          <label className="flex flex-col text-xs text-gray-500 dark:text-gray-400 ml-auto">
            Asesor
            <select
              value={filters.advisor ?? ""}
              onChange={(e) => onAdvisorChange(e.target.value)}
              className="mt-0.5 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-sm text-gray-800 dark:text-gray-100 min-w-[12rem]"
            >
              <option value="">Toda la organización</option>
              <option value="unassigned">Sin asignar</option>
              {advisors.map((a) => (
                <option key={a.membershipId} value={a.membershipId}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {customError ? (
        <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">
          {customError}
        </p>
      ) : null}
    </div>
  );
}
