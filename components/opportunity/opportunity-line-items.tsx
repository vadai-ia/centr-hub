"use client";
import { useState } from "react";
import type { OpportunityLineItemRow } from "@/lib/types/database";
import { formatAmount } from "@/lib/format/money";

interface Props {
  items: OpportunityLineItemRow[];
  currency: string;
}

const COLLAPSED_PREVIEW = 3;

/**
 * Tabla de productos del popup de oportunidad.
 *
 * Lote polish M6:
 *  - Cantidad destacada con badge propio (era texto gris pequeño).
 *  - Lista colapsable: si hay más de `COLLAPSED_PREVIEW` productos se
 *    muestra solo el preview con botón "Ver todos" → expand inline.
 *  - Etiqueta clara "Subtotal de productos" diferenciada del total
 *    de la orden que vive en el header.
 */
export function OpportunityLineItems({ items, currency }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (items.length === 0) {
    return (
      <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-2">
          Productos
        </h3>
        <p className="text-sm text-gray-400 dark:text-gray-500 italic">
          Esta oportunidad aún no tiene productos cargados.
        </p>
      </section>
    );
  }

  const total = items.reduce(
    (acc, it) => acc + Number(it.final_price) * it.quantity,
    0,
  );
  const totalUnits = items.reduce((acc, it) => acc + it.quantity, 0);
  const shouldCollapse = items.length > COLLAPSED_PREVIEW;
  const visible = expanded || !shouldCollapse ? items : items.slice(0, COLLAPSED_PREVIEW);

  return (
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      <header className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between gap-3 bg-amber-50/40 dark:bg-amber-500/5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-amber-600 dark:text-amber-400" aria-hidden>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/>
              <line x1="3" y1="6" x2="21" y2="6"/>
              <path d="M16 10a4 4 0 0 1-8 0"/>
            </svg>
          </span>
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            Productos
          </h3>
          <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
            {items.length} {items.length === 1 ? "ítem" : "ítems"} · {totalUnits} {totalUnits === 1 ? "unidad" : "unidades"}
          </span>
        </div>
        {shouldCollapse && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs font-medium text-amber-700 dark:text-amber-300 hover:underline focus:outline-none focus:underline"
            aria-expanded={expanded}
          >
            {expanded ? "Ocultar" : `Ver todos (${items.length})`}
          </button>
        )}
      </header>
      <ul className="divide-y divide-gray-100 dark:divide-gray-700">
        {visible.map((it) => {
          const lineTotal = Number(it.final_price) * it.quantity;
          return (
            <li key={it.id} className="px-4 py-3 flex items-start gap-3">
              <span
                className="inline-flex items-center justify-center min-w-[2rem] h-7 px-2 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300 text-sm font-semibold tabular-nums flex-shrink-0"
                aria-label={`Cantidad ${it.quantity}`}
              >
                {it.quantity}×
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                  {it.title}
                </p>
                {(it.variant_title || it.sku) && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                    {it.variant_title && <span>{it.variant_title}</span>}
                    {it.variant_title && it.sku && <span> · </span>}
                    {it.sku && <span>SKU {it.sku}</span>}
                  </p>
                )}
              </div>
              <span className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100 flex-shrink-0">
                {formatAmount(lineTotal, currency) ?? "—"}
              </span>
            </li>
          );
        })}
        {shouldCollapse && !expanded && (
          <li className="px-4 py-2.5 text-center">
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="text-xs font-medium text-amber-700 dark:text-amber-300 hover:underline"
            >
              + {items.length - COLLAPSED_PREVIEW} producto{items.length - COLLAPSED_PREVIEW === 1 ? "" : "s"} más
            </button>
          </li>
        )}
      </ul>
      <footer className="px-4 py-3 border-t border-gray-100 dark:border-gray-700 flex items-center justify-between bg-gray-50 dark:bg-gray-900/40">
        <span className="text-xs text-gray-600 dark:text-gray-400 uppercase tracking-wide font-medium">
          Subtotal de productos
        </span>
        <span className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          {formatAmount(total, currency) ?? "—"}
        </span>
      </footer>
    </section>
  );
}
