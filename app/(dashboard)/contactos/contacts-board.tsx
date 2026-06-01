"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  searchContactsAction,
  type ContactsBoardState,
} from "@/lib/actions/contacts";
import type { ContactListRow } from "@/lib/db/contacts";
import { CONTACT_SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { ContactRow } from "./contact-row";

interface Props {
  initial: ContactsBoardState;
}

/**
 * Listado de Contactos (M6 — B2).
 *
 * Estado client-side:
 *   - `query`: texto del input (controlado).
 *   - `appliedQuery`: query realmente aplicada al server (debounced).
 *   - `rows`, `hasMore`, `page`: data del listado.
 *   - `loading`: indicador de fetch en curso.
 *
 * Debounce: cada cambio en `query` agenda un timer
 * (`CONTACT_SEARCH_DEBOUNCE_MS`). Si el usuario sigue tecleando, se
 * limpia. Cuando expira, se invoca `searchContactsAction` con `page=0`.
 *
 * Paginación: botón "Cargar más" reutiliza `searchContactsAction` con
 * `page = current + 1` y concatena al estado. Scroll infinito queda
 * fuera de M6 — botón es UX suficiente y más simple.
 */
export function ContactsBoard({ initial }: Props) {
  const [query, setQuery] = useState(initial.query);
  const [appliedQuery, setAppliedQuery] = useState(initial.query);
  const [rows, setRows] = useState<ContactListRow[]>(initial.rows);
  const [hasMore, setHasMore] = useState(initial.hasMore);
  const [page, setPage] = useState(initial.page);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef(0);

  // Debounce del query — siempre que cambie el texto del input,
  // reagendamos una sola petición.
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

  // Cada vez que el appliedQuery cambia → traemos la primera page.
  // Usamos requestSeq para descartar respuestas obsoletas (race
  // condition si el usuario teclea rápido).
  useEffect(() => {
    if (appliedQuery === initial.query && page === 0 && rows === initial.rows) {
      // Estado inicial — no refetcheamos, ya viene del server snapshot.
      return;
    }
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    searchContactsAction({ query: appliedQuery, page: 0 })
      .then((res) => {
        if (seq !== requestSeqRef.current) return;
        if (!res.ok) {
          setError(res.message);
          return;
        }
        setRows(res.rows);
        setHasMore(res.hasMore);
        setPage(0);
      })
      .catch((e) => {
        if (seq !== requestSeqRef.current) return;
        setError(e instanceof Error ? e.message : "Error al buscar contactos");
      })
      .finally(() => {
        if (seq === requestSeqRef.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedQuery]);

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
      });
      if (seq !== requestSeqRef.current) return;
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setRows((prev) => [...prev, ...res.rows]);
      setHasMore(res.hasMore);
      setPage(res.page);
    } catch (e) {
      if (seq !== requestSeqRef.current) return;
      setError(e instanceof Error ? e.message : "Error al cargar más contactos");
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [appliedQuery, hasMore, loading, page]);

  return (
    <div className="flex flex-col gap-4 h-full">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Contactos
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {initial.role === "vendedor"
              ? "Tus contactos asignados."
              : "Todos los contactos de la organización."}
          </p>
        </div>
        <div className="flex-1 max-w-md">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por nombre, email o teléfono"
            className={[
              "w-full px-3 py-2 text-sm rounded-md",
              "bg-white dark:bg-gray-800",
              "border border-gray-200 dark:border-gray-700",
              "text-gray-900 dark:text-gray-100",
              "placeholder:text-gray-400 dark:placeholder:text-gray-500",
              "focus:outline-none focus:ring-2 focus:ring-indigo-400",
            ].join(" ")}
          />
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="px-4 py-2 rounded-md bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300 text-sm"
        >
          {error}
        </div>
      )}

      <section className="flex-1 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        {rows.length === 0 && !loading ? (
          <EmptyState query={appliedQuery} />
        ) : (
          <div>
            {rows.map((row) => (
              <ContactRow key={row.id} row={row} advisors={initial.advisors} />
            ))}
            {hasMore && (
              <div className="p-3 flex justify-center">
                <button
                  onClick={loadMore}
                  disabled={loading}
                  className={[
                    "text-sm px-4 py-2 rounded-md",
                    "bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
                    "hover:bg-indigo-100 dark:hover:bg-indigo-900/50",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                  ].join(" ")}
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
