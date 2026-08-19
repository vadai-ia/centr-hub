import { formatAmount } from "@/lib/format/money";
import { DASH, formatCivilDate, formatCount, formatPercent } from "@/lib/format/dashboard";
import { DEFAULT_CURRENCY } from "@/lib/constants";
import type { AdvisorBreakdownRow } from "@/lib/types/dashboard";
import type { Funnel } from "@/lib/types/database";

const CCY = DEFAULT_CURRENCY;

/**
 * Drilldown por vendedor (solo admin, sin asesor filtrado). El usuario
 * sistema "Histórico" NO aparece como fila (R10); su revenue sí suma en
 * los totales de la org, por eso la suma de filas puede ser menor que el
 * total mostrado arriba — la diferencia es la contribución de Histórico.
 */
export function AdvisorBreakdown({
  rows,
  funnel,
  snapshotSince = null,
}: {
  rows: AdvisorBreakdownRow[];
  funnel: Funnel;
  /** Corte del snapshot (solo Venta): acota "Pipeline $ actual". */
  snapshotSince?: string | null;
}) {
  if (rows.length === 0) return null;
  const isVenta = funnel === "venta";

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
      <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700/60">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-200">Desglose por vendedor</p>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
          El usuario &quot;Histórico&quot; no se lista; su aporte sí cuenta en los totales de la
          organización.
        </p>
        {isVenta && snapshotSince ? (
          <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
            <span aria-hidden>✂️</span> En &quot;Sin asignar&quot;, el pipeline actual solo cuenta
            oportunidades creadas desde el {formatCivilDate(snapshotSince)}. Las de cada vendedor se
            muestran completas. El tablero del pipeline no aplica este corte, así que muestra más.
          </p>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-900/40">
              <th className="py-2 px-4 font-medium">Vendedor</th>
              {isVenta ? (
                <>
                  <th className="py-2 px-3 font-medium text-right">Revenue</th>
                  <th className="py-2 px-3 font-medium text-right">Cotiz.</th>
                  <th className="py-2 px-3 font-medium text-right">Ganadas</th>
                  <th className="py-2 px-3 font-medium text-right">Perdidas</th>
                  <th className="py-2 px-3 font-medium text-right">Win rate</th>
                  <th className="py-2 px-4 font-medium text-right">Pipeline $ actual</th>
                </>
              ) : (
                <>
                  <th className="py-2 px-3 font-medium text-right">Pedidos</th>
                  <th className="py-2 px-3 font-medium text-right">Activos ahora</th>
                  <th className="py-2 px-4 font-medium text-right">Casos problemáticos</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.membershipId ?? "__unassigned__"}
                className="border-t border-gray-100 dark:border-gray-700/60"
              >
                <td className="py-2 px-4">
                  <span className="flex items-center gap-2">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full flex-shrink-0"
                      style={{ background: r.color ?? "#9CA3AF" }}
                      aria-hidden
                    />
                    <span
                      className={
                        r.isUnassigned
                          ? "italic text-gray-500 dark:text-gray-400"
                          : "text-gray-800 dark:text-gray-100"
                      }
                    >
                      {r.name}
                    </span>
                  </span>
                </td>
                {isVenta ? (
                  <>
                    <td className="py-2 px-3 text-right tabular-nums">{formatAmount(r.revenue, CCY) ?? DASH}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{formatCount(r.quotesSent)}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{formatCount(r.wonCount)}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{formatCount(r.lostCount)}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{formatPercent(r.winRate)}</td>
                    <td className="py-2 px-4 text-right tabular-nums">{formatAmount(r.pipelineGross, CCY) ?? DASH}</td>
                  </>
                ) : (
                  <>
                    <td className="py-2 px-3 text-right tabular-nums">{formatCount(r.ordersCount)}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{formatCount(r.activeOrders)}</td>
                    <td className="py-2 px-4 text-right tabular-nums">{formatCount(r.problematicCases)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
