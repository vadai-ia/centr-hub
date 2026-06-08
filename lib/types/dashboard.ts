import type { Funnel, UUID } from "@/lib/types/database";
import type { PeriodPreset, ResolvedPeriod } from "@/lib/time/period";

/**
 * Tipos del Dashboard descriptivo (M8.2). Solo KPIs descriptivos —
 * sin metas, umbrales, semáforos ni cumplimiento (eso es V2).
 *
 * Convención de "sin datos": los rates (win/loss) y promedios usan
 * `null` cuando el denominador es 0 (la UI muestra "—", nunca NaN).
 * Los conteos y sumas usan 0 (cero es un dato real, no ausencia).
 */

/** Punto de una serie temporal mensual para las gráficas. */
export interface MonthValue {
  monthKey: string; // yyyy-MM
  label: string; // "may 2026"
  value: number;
}

/** KPI 9 — conversión por etapa con umbral de muestra pequeña. */
export interface StageWinRate {
  stageId: UUID;
  stageName: string;
  position: number;
  sample: number;
  /** % que avanzó a una etapa posterior (no perdida). null si muestra <10. */
  rate: number | null;
  smallSample: boolean;
}

/** KPI 11 — pérdidas agrupadas por motivo. */
export interface LossByReason {
  reasonId: UUID | null;
  reasonName: string;
  count: number;
  amount: number;
}

/** KPIs del Funnel Venta (12). */
export interface VentaMetrics {
  revenue: number; // 1
  quotesSent: number; // 2
  pipelineGross: number; // 3 — BRUTO, sin ponderar
  leads: number; // 4
  qualifiedLeads: number; // 5
  wonCount: number; // 6
  activeWithDraft: number; // 7
  winRateGlobal: number | null; // 8
  winRateByStage: StageWinRate[]; // 9
  lossRate: number | null; // 10
  lossesByReason: LossByReason[]; // 11
  salesCycleDays: number | null; // 12
  // Series para gráficas
  revenueByMonth: MonthValue[];
  wonVsLost: { won: number; lost: number };
}

/** KPIs del Funnel Post-venta (3). */
export interface PostventaMetrics {
  ordersCount: number; // 1
  problematicCases: number; // 2
  repurchaseRate: number | null; // 3 — ventana fija 12 meses
  ordersByMonth: MonthValue[];
}

/**
 * Fila del drilldown por vendedor (solo admin). `membershipId === null`
 * representa el grupo "Sin asignar" (orders/opps sin asesor). El
 * usuario sistema "Histórico" NUNCA aparece como fila (R10) aunque su
 * revenue sí suma en los totales de la organización.
 */
export interface AdvisorBreakdownRow {
  membershipId: UUID | null;
  name: string;
  color: string | null;
  isUnassigned: boolean;
  // Venta
  revenue: number;
  quotesSent: number;
  wonCount: number;
  lostCount: number;
  winRate: number | null;
  pipelineGross: number;
  // Post-venta
  ordersCount: number;
  problematicCases: number;
}

export interface DashboardFiltersState {
  funnel: Funnel;
  /** Preset activo, o "custom" si el usuario eligió un rango manual. */
  preset: PeriodPreset | "custom";
  /** Solo presente cuando preset === "custom". */
  customFrom: string | null;
  customTo: string | null;
  /** Solo admin: membership del asesor filtrado, null = todos. */
  advisorMembershipId: UUID | null;
}

/** Snapshot completo que consume el dashboard para un funnel + periodo. */
export interface DashboardData {
  funnel: Funnel;
  period: ResolvedPeriod;
  isAdmin: boolean;
  /** Métricas del scope activo (toda la org, o el asesor filtrado). */
  venta: VentaMetrics | null;
  postventa: PostventaMetrics | null;
  /** Drilldown por vendedor — solo admin y solo cuando no hay asesor filtrado. */
  advisorBreakdown: AdvisorBreakdownRow[] | null;
}
