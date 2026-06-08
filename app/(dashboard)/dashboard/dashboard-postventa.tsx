import { KpiCard } from "./kpi-card";
import { OrdersByMonthChart } from "./dashboard-charts";
import { formatCount, formatPercent } from "@/lib/format/dashboard";
import { DASHBOARD_REPURCHASE_WINDOW_MONTHS } from "@/lib/constants";
import type { PostventaMetrics } from "@/lib/types/dashboard";

export function DashboardPostventa({ m }: { m: PostventaMetrics }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiCard label="Pedidos" value={formatCount(m.ordersCount)} accent="revenue" emphasis />
        <KpiCard label="Casos problemáticos" value={formatCount(m.problematicCases)} accent="lost" emphasis />
        <KpiCard
          label="Tasa de recompra"
          value={formatPercent(m.repurchaseRate)}
          emphasis
          hint={`Clientes con >1 pedido · últimos ${DASHBOARD_REPURCHASE_WINDOW_MONTHS} meses`}
        />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <OrdersByMonthChart data={m.ordersByMonth} />
      </div>
    </div>
  );
}
