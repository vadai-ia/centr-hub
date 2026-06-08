import { KpiCard } from "./kpi-card";
import {
  LossesByReasonChart,
  RevenueByMonthChart,
  WonVsLostChart,
} from "./dashboard-charts";
import { formatAmount } from "@/lib/format/money";
import { DASH, formatCount, formatDays, formatPercent } from "@/lib/format/dashboard";
import { DEFAULT_CURRENCY } from "@/lib/constants";
import type { VentaMetrics } from "@/lib/types/dashboard";

const CCY = DEFAULT_CURRENCY;

export function DashboardVenta({ m }: { m: VentaMetrics }) {
  return (
    <div className="space-y-6">
      {/* KPIs principales destacados */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Revenue cerrado"
          value={formatAmount(m.revenue, CCY) ?? DASH}
          accent="revenue"
          emphasis
        />
        <KpiCard
          label="Pipeline $ (bruto)"
          value={formatAmount(m.pipelineGross, CCY) ?? DASH}
          accent="pipeline"
          emphasis
          hint="Suma bruta de oportunidades vivas"
        />
        <KpiCard
          label="Win rate global"
          value={formatPercent(m.winRateGlobal)}
          accent="won"
          emphasis
          hint={`${formatCount(m.wonVsLost.won)} ganadas · ${formatCount(m.wonVsLost.lost)} perdidas`}
        />
        <KpiCard
          label="Oportunidades ganadas"
          value={formatCount(m.wonCount)}
          accent="won"
          emphasis
        />
      </div>

      {/* KPIs secundarios */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        <KpiCard label="Cotizaciones enviadas" value={formatCount(m.quotesSent)} />
        <KpiCard label="Leads" value={formatCount(m.leads)} />
        <KpiCard label="Leads calificados" value={formatCount(m.qualifiedLeads)} />
        <KpiCard label="Oportunidades activas (con cotización)" value={formatCount(m.activeWithDraft)} />
        <KpiCard label="Loss rate" value={formatPercent(m.lossRate)} accent="lost" />
        <KpiCard label="Sales cycle promedio" value={formatDays(m.salesCycleDays)} hint="Creación → cierre" />
      </div>

      {/* Gráficas */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RevenueByMonthChart data={m.revenueByMonth} currency={CCY} />
        <WonVsLostChart won={m.wonVsLost.won} lost={m.wonVsLost.lost} />
        <LossesByReasonChart data={m.lossesByReason} currency={CCY} />
        <StageWinRateTable m={m} />
      </div>
    </div>
  );
}

function StageWinRateTable({ m }: { m: VentaMetrics }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm">
      <p className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-3">Win rate por etapa</p>
      {m.winRateByStage.length === 0 ? (
        <div className="h-56 flex items-center justify-center text-sm text-gray-400 dark:text-gray-500">
          Sin etapas
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500">
                <th className="py-1.5 pr-2 font-medium">Etapa</th>
                <th className="py-1.5 px-2 font-medium text-right">Muestra</th>
                <th className="py-1.5 pl-2 font-medium text-right">% avanza</th>
              </tr>
            </thead>
            <tbody>
              {m.winRateByStage.map((s) => (
                <tr key={s.stageId} className="border-t border-gray-100 dark:border-gray-700/60">
                  <td className="py-1.5 pr-2 text-gray-700 dark:text-gray-200">{s.stageName}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-gray-500 dark:text-gray-400">
                    {formatCount(s.sample)}
                  </td>
                  <td className="py-1.5 pl-2 text-right tabular-nums">
                    {s.smallSample ? (
                      <span className="text-xs text-amber-600 dark:text-amber-400">Muestra pequeña</span>
                    ) : (
                      <span className="font-medium text-gray-800 dark:text-gray-100">
                        {formatPercent(s.rate)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
