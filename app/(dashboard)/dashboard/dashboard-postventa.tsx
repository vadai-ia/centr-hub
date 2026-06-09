import { KpiCard } from "./kpi-card";
import { DashboardSection } from "./dashboard-section";
import { AdvisorBreakdown } from "./advisor-breakdown";
import { OrdersByMonthChart } from "./dashboard-charts";
import { formatCount } from "@/lib/format/dashboard";
import type { AdvisorBreakdownRow, PostventaMetrics } from "@/lib/types/dashboard";

export function DashboardPostventa({
  m,
  breakdown,
}: {
  m: PostventaMetrics;
  breakdown: AdvisorBreakdownRow[] | null;
}) {
  return (
    <DashboardSection tone="postventa" title="Post-venta" subtitle="Pedidos y atención post-cierre">
      {/* Pedidos: dos métricas (creados en periodo + activos ahora) (#10) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiCard
          label="Pedidos (en el periodo)"
          value={formatCount(m.ordersCount)}
          accent="revenue"
          emphasis
          hint="Creados dentro del rango seleccionado"
        />
        <KpiCard
          label="Pedidos activos ahora"
          value={formatCount(m.activeOrders)}
          accent="pipeline"
          emphasis
          hint="Con caso post-venta abierto (snapshot)"
        />
        <KpiCard
          label="Casos problemáticos"
          value={formatCount(m.problematicCases)}
          accent="lost"
          emphasis
        />
      </div>

      {/* Desglose por vendedor — posición prominente (#4) */}
      {breakdown ? <AdvisorBreakdown rows={breakdown} funnel="post_venta" /> : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <OrdersByMonthChart data={m.ordersByMonth} />
      </div>
    </DashboardSection>
  );
}
