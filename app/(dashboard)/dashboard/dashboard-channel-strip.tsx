import { formatAmount } from "@/lib/format/money";
import type { PostventaMetrics, VentaMetrics } from "@/lib/types/dashboard";

const CCY = "MXN";
const DASH = "—";

function pct(v: number | null): string {
  return v === null ? DASH : `${Math.round(v * 100)}%`;
}

/**
 * Tira comparativa Outbound vs Inbound (F4). SIEMPRE muestra ambos lado a
 * lado (no depende del toggle de canal), respetando el scope/periodo activos.
 * `inbound = NOT outbound`. Responde el requerimiento "medir outbound contra
 * el resto (inbound)".
 */
export function DashboardChannelStrip({
  venta,
  postventa,
}: {
  venta: { outbound: VentaMetrics; inbound: VentaMetrics };
  postventa: { outbound: PostventaMetrics; inbound: PostventaMetrics };
}) {
  const rows: Array<{ label: string; ob: string; in: string }> = [
    {
      label: "Revenue",
      ob: formatAmount(venta.outbound.revenue, CCY) ?? DASH,
      in: formatAmount(venta.inbound.revenue, CCY) ?? DASH,
    },
    { label: "Leads", ob: String(venta.outbound.leads), in: String(venta.inbound.leads) },
    {
      label: "Cotizaciones",
      ob: String(venta.outbound.quotesSent),
      in: String(venta.inbound.quotesSent),
    },
    { label: "Ganadas", ob: String(venta.outbound.wonCount), in: String(venta.inbound.wonCount) },
    {
      label: "Win rate",
      ob: pct(venta.outbound.winRateGlobal),
      in: pct(venta.inbound.winRateGlobal),
    },
    {
      label: "Pedidos (post-venta)",
      ob: String(postventa.outbound.ordersCount),
      in: String(postventa.inbound.ordersCount),
    },
  ];

  return (
    <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Outbound vs Inbound
        </h2>
        <span className="text-[11px] text-gray-400 dark:text-gray-500">
          Inbound = todo lo que no es outbound
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <th className="text-left font-medium py-1.5 pr-4">Métrica</th>
              <th className="text-right font-medium py-1.5 px-4">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full bg-cyan-500" />
                  Outbound
                </span>
              </th>
              <th className="text-right font-medium py-1.5 pl-4">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full bg-gray-400" />
                  Inbound
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-t border-gray-100 dark:border-gray-700/60">
                <td className="py-1.5 pr-4 text-gray-600 dark:text-gray-300">{r.label}</td>
                <td className="py-1.5 px-4 text-right font-semibold tabular-nums text-cyan-700 dark:text-cyan-300">
                  {r.ob}
                </td>
                <td className="py-1.5 pl-4 text-right font-semibold tabular-nums text-gray-800 dark:text-gray-100">
                  {r.in}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
