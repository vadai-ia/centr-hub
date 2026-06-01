import type { ContactOrderIndicators } from "@/lib/db/orders";
import { formatAmount } from "@/lib/format/money";

interface Props {
  indicators: ContactOrderIndicators;
}

/**
 * Banda de indicadores del contacto (M6 — B3).
 *
 * Muestra: total de órdenes ganadas (pagadas + no canceladas) y monto
 * acumulado. R5: cancelado ≠ perdido — canceladas no entran al
 * denominador (excluidas a nivel `sumPaidOrdersForContact`).
 *
 * Server Component: solo recibe data ya calculada y la pinta.
 */
export function ContactIndicators({ indicators }: Props) {
  const moneyText = formatAmount(indicators.paidRevenueTotal, indicators.currency);
  return (
    <section className="grid grid-cols-2 gap-3 sm:gap-4">
      <Card
        label="Órdenes pagadas"
        value={String(indicators.paidOrdersCount)}
        hint="Histórico — excluye canceladas"
      />
      <Card
        label="Monto total"
        value={moneyText ?? "—"}
        hint={`Moneda: ${indicators.currency}`}
      />
    </section>
  );
}

function Card({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700 p-4">
      <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </p>
      <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100 tabular-nums mt-1">
        {value}
      </p>
      <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">{hint}</p>
    </div>
  );
}
