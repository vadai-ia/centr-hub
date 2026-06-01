"use client";
import type { OpportunityLineItemRow } from "@/lib/types/database";
import { formatAmount } from "@/lib/format/money";

interface Props {
  items: OpportunityLineItemRow[];
  currency: string;
}

/**
 * Tabla de line items de la oportunidad (M6 — B4).
 *
 * Mantiene una vista compacta: title + qty + final_price. Detalles
 * adicionales (variant, sku, discount, weight) se pueden añadir
 * en F7 como expandable rows si Centr lo pide.
 */
export function OpportunityLineItems({ items, currency }: Props) {
  if (items.length === 0) {
    return (
      <section className="bg-white dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700 p-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
          Productos
        </h3>
        <p className="text-sm text-gray-400 dark:text-gray-500 italic">
          Esta oportunidad aún no tiene productos cargados.
        </p>
      </section>
    );
  }

  const total = items.reduce((acc, it) => acc + Number(it.final_price) * it.quantity, 0);

  return (
    <section className="bg-white dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700">
      <header className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
          Productos ({items.length})
        </h3>
      </header>
      <ul className="divide-y divide-gray-100 dark:divide-gray-700">
        {items.map((it) => {
          const lineTotal = Number(it.final_price) * it.quantity;
          return (
            <li key={it.id} className="px-4 py-2.5 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-gray-900 dark:text-gray-100 truncate">
                  {it.title}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {it.variant_title && <span>{it.variant_title} · </span>}
                  Cantidad: {it.quantity}
                  {it.sku && <span> · SKU {it.sku}</span>}
                </p>
              </div>
              <span className="text-sm font-medium tabular-nums text-gray-900 dark:text-gray-100 flex-shrink-0">
                {formatAmount(lineTotal, currency) ?? "—"}
              </span>
            </li>
          );
        })}
      </ul>
      <footer className="px-4 py-2.5 border-t border-gray-100 dark:border-gray-700 flex items-center justify-between">
        <span className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          Total
        </span>
        <span className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          {formatAmount(total, currency) ?? "—"}
        </span>
      </footer>
    </section>
  );
}
