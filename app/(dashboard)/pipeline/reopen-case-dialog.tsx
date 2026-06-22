"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  reopenOpportunityAction,
  searchOpportunitiesForReopenAction,
} from "@/lib/actions/pipeline";
import type { ReopenSearchResultItem } from "@/lib/types/pipeline";
import type { UUID } from "@/lib/types/database";

interface Props {
  open: boolean;
  onCancel: () => void;
  /** Se llama tras reabrir con éxito; el board recarga el estado. */
  onSuccess: (opportunityId: UUID) => void;
}

/**
 * Diálogo del botón "+" de "Caso problemático" (M4v2, Bloque D).
 * Busca CUALQUIER oportunidad (cualquier etapa/funnel, incluidas
 * cerradas/canceladas/resueltas) reutilizando el patrón de búsqueda del
 * pipeline, y la reabre en "Caso problemático".
 */
export function ReopenCaseDialog({ open, onCancel, onSuccess }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReopenSearchResultItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [reopeningId, setReopeningId] = useState<UUID | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults(null);
      setSearching(false);
      setReopeningId(null);
      setError(null);
      return;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !reopeningId) onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, reopeningId, onCancel]);

  // Búsqueda con debounce simple (350ms) sobre el query.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length === 0) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      const res = await searchOpportunitiesForReopenAction({ query: q });
      // Evita pisar un query posterior (carrera): solo aplica si el query
      // sigue siendo el mismo al volver.
      setSearching(false);
      if (!res.ok) {
        setError(res.message);
        setResults([]);
        return;
      }
      setError(null);
      setResults(res.results);
    }, 350);
    return () => clearTimeout(handle);
  }, [query, open]);

  const handleReopen = useCallback(
    async (id: UUID) => {
      if (reopeningId) return;
      setReopeningId(id);
      setError(null);
      const res = await reopenOpportunityAction({ opportunityId: id });
      setReopeningId(null);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      onSuccess(res.opportunityId);
    },
    [reopeningId, onSuccess],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[55] flex items-start justify-center px-4 pt-[10vh] bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reopen-case-title"
      onClick={reopeningId ? undefined : onCancel}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full p-6 outline-none"
      >
        <p
          id="reopen-case-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          Reabrir oportunidad en Caso problemático
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Busca cualquier oportunidad (incluidas cerradas, canceladas o
          resueltas) por nombre, teléfono, correo o referencia. Al elegirla,
          se reabre activa en “Caso problemático”.
        </p>

        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          placeholder="Nombre, teléfono, correo o #referencia…"
          className="w-full mt-4 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-3 py-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-amber-400"
        />

        {error && (
          <div
            role="alert"
            className="mt-3 px-3 py-2 rounded-md bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300 text-sm"
          >
            {error}
          </div>
        )}

        <div className="mt-3 max-h-[45vh] overflow-y-auto centr-scrollbar -mx-1 px-1">
          {searching && (
            <p className="text-sm text-gray-400 dark:text-gray-500 py-6 text-center">
              Buscando…
            </p>
          )}
          {!searching && results !== null && results.length === 0 && (
            <p className="text-sm text-gray-400 dark:text-gray-500 py-6 text-center">
              Sin resultados para “{query.trim()}”.
            </p>
          )}
          {!searching && results !== null && results.length > 0 && (
            <ul className="space-y-1.5">
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => void handleReopen(r.id)}
                    disabled={reopeningId !== null}
                    className="w-full text-left rounded-md border border-gray-200 dark:border-gray-700 px-3 py-2 hover:border-amber-300 hover:bg-amber-50/50 dark:hover:bg-amber-500/5 transition-colors disabled:opacity-50"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {r.contactName}
                      </span>
                      <StatusChip label={r.statusLabel} />
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                      <span>{r.funnel === "venta" ? "Venta" : "Post-venta"}</span>
                      {r.stageName && <span>· {r.stageName}</span>}
                      {r.reference && (
                        <span className="font-mono truncate">· {r.reference}</span>
                      )}
                      {reopeningId === r.id && <span>· Reabriendo…</span>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={reopeningId !== null}
            className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusChip({ label }: { label: string }) {
  const tone =
    label === "Cancelada"
      ? "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
      : label === "Resuelto"
        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
        : label === "Perdida"
          ? "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
          : label === "Ganada" || label === "Caso cerrado"
            ? "bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300"
            : "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300";
  return (
    <span
      className={`text-[9px] uppercase tracking-wide px-1.5 py-px rounded font-medium flex-shrink-0 ${tone}`}
    >
      {label}
    </span>
  );
}
