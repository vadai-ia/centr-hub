"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  searchContactsAction,
  type ContactsBoardState,
} from "@/lib/actions/contacts";
import type { ContactListRow, DerivedAdvisor } from "@/lib/db/contacts";
import type { UUID } from "@/lib/types/database";
import { CONTACT_SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { ContactRow } from "./contact-row";
import { CreateLeadButton } from "@/components/leads/create-lead-dialog";

interface Props {
  initial: ContactsBoardState;
}

interface ContactFilters {
  dateFrom: string | null;
  dateTo: string | null;
  advisorId: UUID | null;
  /** Fix A: ver contactos archivados por borrado en Whaapy. */
  includeArchived: boolean;
}

export function ContactsBoard({ initial }: Props) {
  const [query, setQuery] = useState(initial.query);
  const [appliedQuery, setAppliedQuery] = useState(initial.query);
  const [filters, setFilters] = useState<ContactFilters>({
    dateFrom: null,
    dateTo: null,
    advisorId: null,
    includeArchived: false,
  });
  const [rows, setRows] = useState<ContactListRow[]>(initial.rows);
  const [hasMore, setHasMore] = useState(initial.hasMore);
  const [page, setPage] = useState(initial.page);
  const [totalCount, setTotalCount] = useState(initial.totalCount);
  const [filteredCount, setFilteredCount] = useState(initial.filteredCount);
  const [derivedAdvisors, setDerivedAdvisors] = useState<Record<UUID, DerivedAdvisor>>(
    initial.derivedAdvisors,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef(0);

  const isAdmin = initial.role === "admin" || initial.role === "superadmin";

  useEffect(() => {
    if (query === appliedQuery) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setAppliedQuery(query);
    }, CONTACT_SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, appliedQuery]);

  const runSearch = useCallback(
    async (resetPage: boolean) => {
      const seq = ++requestSeqRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await searchContactsAction({
          query: appliedQuery,
          page: resetPage ? 0 : page,
          filterAdvisorId: filters.advisorId,
          dateFrom: filters.dateFrom ? `${filters.dateFrom}T00:00:00.000Z` : undefined,
          dateTo: filters.dateTo ? `${filters.dateTo}T23:59:59.999Z` : undefined,
          includeArchived: filters.includeArchived,
        });
        if (seq !== requestSeqRef.current) return;
        if (!res.ok) {
          setError(res.message);
          return;
        }
        setRows(res.rows);
        setHasMore(res.hasMore);
        setPage(0);
        setTotalCount(res.totalCount);
        setFilteredCount(res.filteredCount);
        setDerivedAdvisors(res.derivedAdvisors);
      } catch (e) {
        if (seq !== requestSeqRef.current) return;
        setError(e instanceof Error ? e.message : "Error al buscar contactos");
      } finally {
        if (seq === requestSeqRef.current) setLoading(false);
      }
    },
    [appliedQuery, filters, page],
  );

  // Trigger search cuando query aplicada o filtros cambien (saltando
  // el render inicial — initial.rows ya viene del server snapshot).
  const initialRef = useRef(true);
  useEffect(() => {
    if (initialRef.current) {
      initialRef.current = false;
      return;
    }
    void runSearch(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedQuery, filters.advisorId, filters.dateFrom, filters.dateTo, filters.includeArchived]);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    const nextPage = page + 1;
    try {
      const res = await searchContactsAction({
        query: appliedQuery,
        page: nextPage,
        filterAdvisorId: filters.advisorId,
        dateFrom: filters.dateFrom ? `${filters.dateFrom}T00:00:00.000Z` : undefined,
        dateTo: filters.dateTo ? `${filters.dateTo}T23:59:59.999Z` : undefined,
        includeArchived: filters.includeArchived,
      });
      if (seq !== requestSeqRef.current) return;
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setRows((prev) => [...prev, ...res.rows]);
      setHasMore(res.hasMore);
      setPage(res.page);
      setTotalCount(res.totalCount);
      setFilteredCount(res.filteredCount);
      setDerivedAdvisors((prev) => ({ ...prev, ...res.derivedAdvisors }));
    } catch (e) {
      if (seq !== requestSeqRef.current) return;
      setError(e instanceof Error ? e.message : "Error al cargar más contactos");
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [appliedQuery, filters, hasMore, loading, page]);

  const hasAnyFilter =
    filters.dateFrom !== null ||
    filters.dateTo !== null ||
    filters.advisorId !== null ||
    filters.includeArchived;

  // "Acotado" = búsqueda/fecha/asesor activos. El toggle de archivados NO
  // cuenta (reajusta el scope base, que ya se refleja en totalCount).
  const narrowed =
    appliedQuery.trim().length > 0 ||
    filters.dateFrom !== null ||
    filters.dateTo !== null ||
    filters.advisorId !== null;
  const fmtCount = (n: number) => n.toLocaleString("es-MX");
  const countLabel = narrowed
    ? `Mostrando ${fmtCount(filteredCount)} de ${fmtCount(totalCount)}`
    : `${fmtCount(totalCount)} ${totalCount === 1 ? "contacto" : "contactos"}`;

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-50">Contactos</h1>
          <p
            className="text-sm text-gray-500 dark:text-gray-400 tabular-nums"
            aria-live="polite"
          >
            {countLabel}
            {initial.role === "vendedor" && (
              <span className="text-gray-400 dark:text-gray-500"> · asignados a ti</span>
            )}
          </p>
        </div>
        <div className="flex-1 min-w-[200px] max-w-md">
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            </span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por nombre, email o teléfono"
              className="w-full pl-9 pr-3 py-2 text-sm rounded-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
          </div>
        </div>
        <CreateLeadButton />
      </header>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2 pb-2 border-b border-gray-200 dark:border-gray-700">
        <DateInput
          label="Desde"
          value={filters.dateFrom}
          onChange={(v) => setFilters((f) => ({ ...f, dateFrom: v }))}
        />
        <DateInput
          label="Hasta"
          value={filters.dateTo}
          onChange={(v) => setFilters((f) => ({ ...f, dateTo: v }))}
        />
        {isAdmin && (
          <select
            value={filters.advisorId ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setFilters((f) => ({ ...f, advisorId: v === "" ? null : (v as UUID) }));
            }}
            className="text-sm rounded-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400"
            aria-label="Filtrar por asesor"
          >
            <option value="">Todos los asesores</option>
            {initial.advisors.map((a) => (
              <option key={a.membershipId} value={a.membershipId}>
                {a.fullName}
              </option>
            ))}
          </select>
        )}
        <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={filters.includeArchived}
            onChange={(e) =>
              setFilters((f) => ({ ...f, includeArchived: e.target.checked }))
            }
            className="rounded border-gray-300 dark:border-gray-600 text-amber-500 focus:ring-amber-400"
          />
          <span>Ver archivados</span>
        </label>
        {hasAnyFilter && (
          <button
            type="button"
            onClick={() =>
              setFilters({ dateFrom: null, dateTo: null, advisorId: null, includeArchived: false })
            }
            className="text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-rose-600 dark:hover:text-rose-400 transition-colors px-2 py-1"
          >
            Limpiar
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="px-4 py-2 rounded-md bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      <section className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        {rows.length === 0 && !loading ? (
          <EmptyState query={appliedQuery} />
        ) : (
          <div>
            {rows.map((row) => (
              <ContactRow
                key={row.id}
                row={row}
                advisors={initial.advisors}
                derivedAdvisor={derivedAdvisors[row.id]}
              />
            ))}
            {hasMore && (
              <div className="p-3 flex justify-center">
                <button
                  onClick={loadMore}
                  disabled={loading}
                  className="text-sm font-medium px-4 py-2 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? "Cargando..." : "Cargar más"}
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function DateInput({
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

function EmptyState({ query }: { query: string }) {
  return (
    <div className="text-center py-16 px-6 text-gray-400 dark:text-gray-500">
      <p className="text-base font-medium text-gray-600 dark:text-gray-300">
        {query ? "Sin resultados" : "Aún no hay contactos"}
      </p>
      <p className="mt-2 text-sm">
        {query
          ? `Ningún contacto coincide con "${query}".`
          : "Los contactos aparecen al sincronizarse desde Shopify y Whaapy."}
      </p>
    </div>
  );
}
