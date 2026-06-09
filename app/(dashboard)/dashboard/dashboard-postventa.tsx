import { KpiCard } from "./kpi-card";
import { DashboardSection } from "./dashboard-section";
import { AdvisorBreakdown } from "./advisor-breakdown";
import { OrdersByMonthChart } from "./dashboard-charts";
import { IconAlert, IconBox, IconPulse } from "./kpi-icons";
import { formatCount } from "@/lib/format/dashboard";
import type { AdvisorBreakdownRow, PostventaMetrics } from "@/lib/types/dashboard";

/** Tooltips estáticos, fieles al cálculo real (lib/db/dashboard.ts). */
const TT = {
  orders:
    "Pedidos creados en el periodo, contados por su fecha real de creación en Shopify. Cuenta pagados y pendientes por igual.",
  active:
    "Pedidos distintos con al menos un caso de Post-venta abierto en este momento. Es una foto del estado actual — no depende del periodo seleccionado.",
  problematic:
    "Oportunidades de Post-venta que están ahora mismo en la etapa 'Caso problemático'. Es una foto del estado actual.",
  ordersByMonth:
    "Pedidos distribuidos por mes según su fecha real de creación en Shopify.",
} as const;

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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          label="Pedidos (en el periodo)"
          value={formatCount(m.ordersCount)}
          accent="revenue"
          emphasis
          icon={<IconBox />}
          hint="Creados dentro del rango seleccionado"
          tooltip={TT.orders}
        />
        <KpiCard
          label="Pedidos activos ahora"
          value={formatCount(m.activeOrders)}
          accent="pipeline"
          emphasis
          icon={<IconPulse />}
          hint="Con caso post-venta abierto (snapshot)"
          tooltip={TT.active}
        />
        <KpiCard
          label="Casos problemáticos"
          value={formatCount(m.problematicCases)}
          accent="lost"
          emphasis
          icon={<IconAlert />}
          tooltip={TT.problematic}
        />
      </div>

      {/* Desglose por vendedor — posición prominente (#4) */}
      {breakdown ? <AdvisorBreakdown rows={breakdown} funnel="post_venta" /> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <OrdersByMonthChart data={m.ordersByMonth} tooltip={TT.ordersByMonth} />
      </div>
    </DashboardSection>
  );
}
