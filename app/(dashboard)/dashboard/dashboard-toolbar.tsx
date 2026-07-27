"use client";
import { useEffect, useState } from "react";
import type { AdvisorOption, DashboardFiltersInput } from "@/lib/actions/dashboard";

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
  onPresetChange: (p: DashboardFiltersInput["preset"]) => void;
  /** Aplica el rango personalizado (botón "Aplicar" — M8.2 ajuste #6). */
  onCustomApply: (from: string, to: string) => void;
  onAdvisorChange: (advisor: string) => void;
  /** Corte por canal (F4) — disponible a cualquier rol. */
  onChannelChange: (channel: NonNullable<DashboardFiltersInput["channel"]>) => void;
  onExport: () => void;
}

const CHANNEL_BUTTONS: Array<{ value: NonNullable<DashboardFiltersInput["channel"]>; label: string }> = [
  { value: "all", label: "Todo" },
  { value: "outbound", label: "Outbound" },
  { value: "inbound", label: "Inbound" },
];

/**
 * Barra de filtros del Dashboard (M8.2 rediseño). Sin toggle de funnel
 * (#2): ambas secciones se muestran juntas. El filtro de asesor vive en
 * la misma fila que los botones de periodo (#3). El rango personalizado
 * se confirma con un botón "Aplicar" explícito (#6) para evitar disparos
 * parciales mientras el usuario completa las dos fechas.
 */
export function DashboardToolbar({
  filters,
  isAdmin,
  advisors,
  pending,
  customError,
  onPresetChange,
  onCustomApply,
  onAdvisorChange,
  onChannelChange,
  onExport,
}: Props) {
  const isCustom = filters.preset === "custom";
  const activeChannel = filters.channel ?? "all";

  // Draft local de las fechas: el dashboard NO se recalcula hasta "Aplicar".
  const [draftFrom, setDraftFrom] = useState(filters.customFrom ?? "");
  const [draftTo, setDraftTo] = useState(filters.customTo ?? "");
  useEffect(() => {
    setDraftFrom(filters.customFrom ?? "");
    setDraftTo(filters.customTo ?? "");
  }, [filters.customFrom, filters.customTo]);

  const canApply = draftFrom !== "" && draftTo !== "";

  function presetBtn(value: DashboardFiltersInput["preset"], label: string) {
    const active = filters.preset === value;
    return (
      <button
        key={value}
        type="button"
        onClick={() => onPresetChange(value)}
        className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
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
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {/* Periodo */}
        <div className="flex flex-wrap items-center gap-1.5">
          {PRESET_BUTTONS.map((b) => presetBtn(b.value, b.label))}
          {presetBtn("custom", "Personalizado")}
        </div>

        {/* Canal (F4) — Todo / Outbound / Inbound. Segmentado, para todos. */}
        <div
          role="tablist"
          aria-label="Canal"
          className="inline-flex rounded-md border border-gray-200 dark:border-gray-700 p-0.5"
        >
          {CHANNEL_BUTTONS.map((c) => {
            const active = activeChannel === c.value;
            return (
              <button
                key={c.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onChannelChange(c.value)}
                className={`px-2.5 py-1 text-sm rounded transition-colors ${
                  active
                    ? "bg-cyan-600 text-white"
                    : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>

        {/* Asesor (admin) — junto a los botones de periodo (#3) */}
        {isAdmin ? (
          <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Asesor
            <select
              value={filters.advisor ?? ""}
              onChange={(e) => onAdvisorChange(e.target.value)}
              className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm font-normal normal-case text-gray-800 dark:text-gray-100 min-w-[12rem]"
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

        <div className="flex items-center gap-2 ml-auto">
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

      {isCustom ? (
        <div className="flex flex-wrap items-end gap-2 border-t border-gray-100 dark:border-gray-700/60 pt-3">
          <label className="flex flex-col text-xs text-gray-500 dark:text-gray-400">
            Desde
            <input
              type="date"
              value={draftFrom}
              max={draftTo || undefined}
              onChange={(e) => setDraftFrom(e.target.value)}
              className="mt-0.5 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-sm text-gray-800 dark:text-gray-100"
            />
          </label>
          <label className="flex flex-col text-xs text-gray-500 dark:text-gray-400">
            Hasta
            <input
              type="date"
              value={draftTo}
              min={draftFrom || undefined}
              onChange={(e) => setDraftTo(e.target.value)}
              className="mt-0.5 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-sm text-gray-800 dark:text-gray-100"
            />
          </label>
          <button
            type="button"
            disabled={!canApply}
            onClick={() => onCustomApply(draftFrom, draftTo)}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Aplicar
          </button>
        </div>
      ) : null}

      {customError ? (
        <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">
          {customError}
        </p>
      ) : null}
    </div>
  );
}
