"use client";
import { useEffect, useState } from "react";
import type { AdvisorOption } from "@/lib/types/pipeline";
import type { UUID } from "@/lib/types/database";

export interface ActiveFilters {
  /** yyyy-mm-dd o null. */
  dateFrom: string | null;
  dateTo: string | null;
  /** UUID de membership o null. */
  advisorId: UUID | null;
  query: string;
}

interface Props {
  filters: ActiveFilters;
  advisors: AdvisorOption[];
  showAdvisorFilter: boolean;
  onChange: (next: ActiveFilters) => void;
}

const QUERY_DEBOUNCE_MS = 300;

/**
 * Barra de filtros del pipeline (lote polish M6).
 *
 * Filtros: rango de fechas, asesor (admin), búsqueda libre. La query
 * se debouncea client-side para no saturar la BD mientras el usuario
 * teclea. Persistencia: solo durante la sesión — no se guarda nada.
 */
export function PipelineFiltersBar({ filters, advisors, showAdvisorFilter, onChange }: Props) {
  const [localQuery, setLocalQuery] = useState(filters.query);

  useEffect(() => {
    setLocalQuery(filters.query);
  }, [filters.query]);

  useEffect(() => {
    if (localQuery === filters.query) return;
    const handle = setTimeout(() => {
      onChange({ ...filters, query: localQuery });
    }, QUERY_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localQuery]);

  const hasAnyFilter =
    filters.dateFrom !== null ||
    filters.dateTo !== null ||
    filters.advisorId !== null ||
    (filters.query.trim().length > 0);

  function clear() {
    setLocalQuery("");
    onChange({ dateFrom: null, dateTo: null, advisorId: null, query: "" });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 mb-3 pb-3 border-b border-gray-200 dark:border-gray-700">
      <div className="relative flex-1 min-w-[180px] max-w-xs">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </span>
        <input
          type="search"
          value={localQuery}
          onChange={(e) => setLocalQuery(e.target.value)}
          placeholder="Buscar por nombre, teléfono, referencia"
          className="w-full pl-8 pr-2 py-1.5 text-sm rounded-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-400"
        />
      </div>

      <DateRangeInput
        label="Desde"
        value={filters.dateFrom}
        onChange={(v) => onChange({ ...filters, dateFrom: v })}
      />
      <DateRangeInput
        label="Hasta"
        value={filters.dateTo}
        onChange={(v) => onChange({ ...filters, dateTo: v })}
      />

      {showAdvisorFilter && (
        <select
          value={filters.advisorId ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            onChange({ ...filters, advisorId: v === "" ? null : (v as UUID) });
          }}
          className="text-sm rounded-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400"
          aria-label="Filtrar por asesor"
        >
          <option value="">Todos los asesores</option>
          {advisors.map((a) => (
            <option key={a.membershipId} value={a.membershipId}>
              {a.fullName}
            </option>
          ))}
        </select>
      )}

      {hasAnyFilter && (
        <button
          type="button"
          onClick={clear}
          className="text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-rose-600 dark:hover:text-rose-400 transition-colors px-2 py-1"
        >
          Limpiar filtros
        </button>
      )}
    </div>
  );
}

function DateRangeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
      <span>{label}</span>
      <input
        type="date"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="text-sm rounded-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400"
      />
    </label>
  );
}
