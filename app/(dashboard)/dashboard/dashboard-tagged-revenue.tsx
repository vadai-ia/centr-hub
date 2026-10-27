import { InfoTooltip } from "./info-tooltip";
import { formatCount } from "@/lib/format/dashboard";
import { formatAmount } from "@/lib/format/money";
import type { AdvisorBreakdownRow, TaggedRevenueSeries } from "@/lib/types/dashboard";

const TOOLTIP =
  "Cuánto se vendió con cada etiqueta de Shopify en el periodo, mes por mes. " +
  "Se mide igual que el resto del tablero: por subtotal, sin pedidos cancelados y " +
  "repartiendo los anticipos en el mes que les toca. OJO: esta venta NO es aparte — " +
  "ya está contada en 'Venta cobrada' y en la meta de quien la hizo, así que no se " +
  "suma encima. Responde al filtro de periodo y de vendedor. Las etiquetas que se " +
  "muestran aquí las define el admin.";

/**
 * Venta por ETIQUETA de Shopify (Evento, …). Pedido de la dirección: "saber
 * cuánto se está vendiendo por mes con la etiqueta, que sea el total".
 *
 * No se renderiza si la organización no configuró etiquetas — una tarjeta en
 * ceros para algo que nadie usa es ruido.
 */
export function TaggedRevenueCard({
  series,
  currency,
  breakdown,
}: {
  series: TaggedRevenueSeries[];
  currency: string;
  /** Para poner nombre a cada asesor del desglose. null = vista de vendedor,
   *  que no recibe el desglose de toda la organización. */
  breakdown?: AdvisorBreakdownRow[] | null;
}) {
  if (series.length === 0) return null;

  const advisorName = new Map(
    (breakdown ?? []).map((r) => [r.membershipId, r.name] as const),
  );

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-200">
        Venta por etiqueta
        <InfoTooltip label="Venta por etiqueta" content={TOOLTIP} />
      </div>

      <div className="space-y-5">
        {series.map((s) => {
          const top = Math.max(...s.byMonth.map((m) => m.value), 0);
          return (
            <div key={s.tag}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm text-gray-600 dark:text-gray-300">{s.tag}</span>
                <span className="shrink-0 text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-50">
                  {formatAmount(s.total, currency)}
                </span>
              </div>
              <p className="mb-2 text-[11px] text-gray-400 dark:text-gray-500">
                {s.count === 0
                  ? "sin venta en el periodo"
                  : `total del periodo · ${formatCount(s.count)} ${s.count === 1 ? "venta" : "ventas"}`}
              </p>

              {s.byMonth.length > 0 && (
                <ul className="space-y-1.5">
                  {s.byMonth.map((m) => (
                    <li key={m.monthKey}>
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="truncate capitalize text-gray-600 dark:text-gray-300">
                          {m.label}
                        </span>
                        <span className="shrink-0 tabular-nums font-medium text-gray-800 dark:text-gray-100">
                          {formatAmount(m.value, currency)}
                        </span>
                      </div>
                      <div className="mt-0.5 h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700/60">
                        {/* Un mes en CERO va sin relleno: el mínimo visual de
                            las otras barras aquí se lee como "casi nada"
                            cuando en realidad no se vendió nada. */}
                        <div
                          className="h-full rounded-full bg-violet-500/80 dark:bg-violet-400/70"
                          style={{
                            width:
                              m.value > 0 && top > 0
                                ? `${Math.max((m.value / top) * 100, 1.5)}%`
                                : "0%",
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {/* Quién la vendió. Lo pidió la dirección para poder
                  identificarlo vendedor por vendedor; solo aparecen quienes
                  vendieron algo con la etiqueta. */}
              {s.byAdvisor.length > 0 && (
                <>
                  <p className="mt-3 mb-1 text-[11px] font-medium text-gray-600 dark:text-gray-300">
                    Quién la vendió
                  </p>
                  <ul className="space-y-0.5">
                    {s.byAdvisor.map((a) => (
                      <li
                        key={a.membershipId ?? "sin-asignar"}
                        className="flex items-baseline justify-between gap-2 text-xs"
                      >
                        <span className="truncate text-gray-600 dark:text-gray-300">
                          {a.membershipId === null
                            ? "Sin asignar"
                            : (advisorName.get(a.membershipId) ?? "Vendedor")}
                        </span>
                        <span className="shrink-0 tabular-nums font-medium text-gray-800 dark:text-gray-100">
                          {formatAmount(a.amount, currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* La misma advertencia que el embudo: dos números correctos puestos
          uno sobre otro se leen como que la data no cuadra. */}
      <p className="mt-3 text-[11px] leading-snug text-gray-400 dark:text-gray-500">
        Esta venta ya está incluida en &quot;Venta cobrada&quot; y en la meta de quien la hizo —
        es un desglose, no un canal aparte.
      </p>
    </div>
  );
}
