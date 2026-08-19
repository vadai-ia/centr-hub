import type { ReactNode } from "react";
import { KpiCard } from "./kpi-card";
import { DashboardSection } from "./dashboard-section";
import { AdvisorBreakdown } from "./advisor-breakdown";
import { InfoTooltip } from "./info-tooltip";
import { IconCheck, IconPipeline, IconRevenue, IconTrophy } from "./kpi-icons";
import {
  LossesByReasonChart,
  RevenueByMonthChart,
  WonVsLostChart,
} from "./dashboard-charts";
import { formatAmount } from "@/lib/format/money";
import { DASH, formatCivilDate, formatCount, formatDays, formatPercent } from "@/lib/format/dashboard";
import { DEFAULT_CURRENCY } from "@/lib/constants";
import type { AdvisorBreakdownRow, VentaMetrics } from "@/lib/types/dashboard";

const CCY = DEFAULT_CURRENCY;

/**
 * Textos de tooltip — ESTÁTICOS y fieles al cálculo real (verificado
 * contra lib/db/dashboard.ts y lib/services/dashboard-metrics.ts).
 */
const TT = {
  revenue:
    "Suma de pedidos pagados en el periodo, contados por la fecha de pago real de Shopify. Solo pedidos con estado pagado.",
  pipelineNow:
    "Foto del momento: suma de los montos de las oportunidades vivas AHORA (ni ganadas, ni perdidas, ni canceladas). NO depende del filtro de fecha, solo del asesor. Es bruto: sin ponderar. Usa el monto real, o el estimado si aún no hay real.",
  pipelinePeriod:
    "Suma de los montos de las oportunidades vivas que se CREARON en el periodo seleccionado. Responde al filtro de fecha. Es bruto: sin ponderar. Usa el monto real, o el estimado si aún no hay real.",
  winRate:
    "De las oportunidades cerradas en el periodo: Ganadas ÷ (Ganadas + Perdidas). No incluye canceladas. Muestra — si no hubo cierres.",
  won: "Oportunidades de Venta marcadas como ganadas en el periodo, por su fecha real de ganada (la fecha del pedido en Shopify).",
  leads:
    "Oportunidades que entraron a la etapa inicial 'Lead nuevo' durante el periodo. No incluye canceladas.",
  qualified:
    "Oportunidades que entraron a una etapa de calificación durante el periodo. No incluye canceladas.",
  quotes:
    "Oportunidades de Venta con cotización (Draft Order de Shopify) creadas en el periodo, por su fecha real de creación en Shopify. No incluye canceladas.",
  active:
    "Foto del momento: oportunidades vivas AHORA con cotización (Draft Order) en la etapa Cotización o posterior. NO depende del filtro de fecha, solo del asesor. Coincide con lo que muestra el pipeline.",
  lossRate:
    "De las oportunidades cerradas en el periodo: Perdidas ÷ (Ganadas + Perdidas). No incluye canceladas.",
  cycle:
    "Promedio de días desde la creación real de la oportunidad hasta su fecha de ganada, sobre las oportunidades ganadas en el periodo.",
  revenueByMonth:
    "Revenue (pedidos pagados) distribuido por mes, según la fecha de pago real de Shopify.",
  wonVsLost: "Conteo de oportunidades ganadas y perdidas en el periodo.",
  lossesByReason:
    "Oportunidades perdidas en el periodo agrupadas por su motivo de pérdida (conteo y monto).",
  stageWinRate:
    "De las oportunidades que pasaron por cada etapa en el periodo, % que después avanzó a una etapa posterior no perdida. Llegar a Ganada cuenta; llegar a Perdida no.",
} as const;

/**
 * Con corte configurado, las dos frases que los tooltips del snapshot dan
 * por ciertas ("coincide con el pipeline", "no depende de fechas") dejan
 * de serlo a medias: sigue sin responder al filtro, pero está acotado.
 * Se declara ahí mismo en vez de dejar un tooltip que miente.
 */
function withCutoffNote(base: string, snapshotSince: string | null): string {
  if (!snapshotSince) return base;
  return `${base} Acotado por configuración a lo creado desde el ${formatCivilDate(
    snapshotSince,
  )}: puede ser menor que lo que muestra el pipeline, que no aplica ese corte.`;
}

function SubGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
        {title}
      </p>
      {children}
    </div>
  );
}

/**
 * Sección "Estado actual" — métricas snapshot que NO responden al filtro
 * de fecha (solo al de asesor). Se separa visualmente de las métricas de
 * periodo (recuadro propio + chip "Foto del momento") para que quede
 * claro que ignoran el rango de fechas — esa confusión originó el ajuste.
 */
function EstadoActualGroup({
  children,
  snapshotSince,
}: {
  children: ReactNode;
  snapshotSince: string | null;
}) {
  return (
    <div className="space-y-2.5 rounded-xl border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50/60 dark:bg-gray-800/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-300">
          Estado actual
        </p>
        <span className="inline-flex items-center gap-1 rounded-full bg-gray-200/80 dark:bg-gray-700/80 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:text-gray-300">
          <span aria-hidden>📸</span> Foto del momento · no depende del filtro de fecha
        </span>
        {/* Con corte configurado el snapshot deja de coincidir con el
            kanban: hay que declararlo o el número se lee como el total. */}
        {snapshotSince ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-200">
            <span aria-hidden>✂️</span> Solo lo creado desde el {formatCivilDate(snapshotSince)} · el
            pipeline muestra todo
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function DashboardVenta({
  m,
  breakdown,
  snapshotSince,
}: {
  m: VentaMetrics;
  breakdown: AdvisorBreakdownRow[] | null;
  snapshotSince: string | null;
}) {
  return (
    <DashboardSection tone="venta" title="Venta" subtitle="Pipeline comercial y cierre">
      <EstadoActualGroup snapshotSince={snapshotSince}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <KpiCard
            label="Activas (con cotización)"
            value={formatCount(m.activeWithDraft)}
            accent="pipeline"
            tooltip={withCutoffNote(TT.active, snapshotSince)}
          />
          <KpiCard
            label="Pipeline $ actual"
            value={formatAmount(m.pipelineGrossNow, CCY) ?? DASH}
            accent="pipeline"
            icon={<IconPipeline />}
            hint={snapshotSince ? "Bruto · vivas ahora · acotado" : "Bruto · vivas ahora"}
            tooltip={withCutoffNote(TT.pipelineNow, snapshotSince)}
          />
        </div>
      </EstadoActualGroup>

      <SubGroup title="Resultados clave">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Revenue cerrado"
            value={formatAmount(m.revenue, CCY) ?? DASH}
            accent="revenue"
            emphasis
            icon={<IconRevenue />}
            tooltip={TT.revenue}
          />
          <KpiCard
            label="Pipeline $ en el periodo"
            value={formatAmount(m.pipelineGrossPeriod, CCY) ?? DASH}
            accent="pipeline"
            emphasis
            icon={<IconPipeline />}
            hint="Bruto · opps creadas en el periodo"
            tooltip={TT.pipelinePeriod}
          />
          <KpiCard
            label="Win rate global"
            value={formatPercent(m.winRateGlobal)}
            accent="won"
            emphasis
            icon={<IconTrophy />}
            hint={`${formatCount(m.wonVsLost.won)} ganadas · ${formatCount(m.wonVsLost.lost)} perdidas`}
            tooltip={TT.winRate}
          />
          <KpiCard
            label="Oportunidades ganadas"
            value={formatCount(m.wonCount)}
            accent="won"
            emphasis
            icon={<IconCheck />}
            tooltip={TT.won}
          />
        </div>
      </SubGroup>

      <SubGroup title="Embudo de venta">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiCard label="Leads" value={formatCount(m.leads)} tooltip={TT.leads} />
          <KpiCard label="Leads calificados" value={formatCount(m.qualifiedLeads)} tooltip={TT.qualified} />
          <KpiCard label="Cotizaciones enviadas" value={formatCount(m.quotesSent)} tooltip={TT.quotes} />
        </div>
      </SubGroup>

      <SubGroup title="Calidad de cierre">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiCard label="Loss rate" value={formatPercent(m.lossRate)} accent="lost" tooltip={TT.lossRate} />
          <KpiCard
            label="Sales cycle promedio"
            value={formatDays(m.salesCycleDays)}
            hint="Creación → cierre"
            tooltip={TT.cycle}
          />
        </div>
      </SubGroup>

      {/* Desglose por vendedor — posición prominente (#4) */}
      {breakdown ? (
        <AdvisorBreakdown rows={breakdown} funnel="venta" snapshotSince={snapshotSince} />
      ) : null}

      {/* Gráficas */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RevenueByMonthChart data={m.revenueByMonth} currency={CCY} tooltip={TT.revenueByMonth} />
        <WonVsLostChart won={m.wonVsLost.won} lost={m.wonVsLost.lost} tooltip={TT.wonVsLost} />
        <LossesByReasonChart data={m.lossesByReason} currency={CCY} tooltip={TT.lossesByReason} />
        <StageWinRateTable m={m} />
      </div>
    </DashboardSection>
  );
}

function StageWinRateTable({ m }: { m: VentaMetrics }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm">
      <p className="mb-3 flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-200">
        Win rate por etapa
        <InfoTooltip label="Win rate por etapa" content={TT.stageWinRate} />
      </p>
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
                    <span className="font-medium text-gray-800 dark:text-gray-100">
                      {formatPercent(s.rate)}
                    </span>
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
