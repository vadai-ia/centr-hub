import type { UUID } from "@/lib/types/database";
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

/** KPI 9 — conversión por etapa. */
export interface StageWinRate {
  stageId: UUID;
  stageName: string;
  position: number;
  sample: number;
  /** % que avanzó a una etapa posterior (no perdida). null si muestra = 0. */
  rate: number | null;
}

/** KPI 11 — pérdidas agrupadas por motivo. */
export interface LossByReason {
  reasonId: UUID | null;
  reasonName: string;
  count: number;
  amount: number;
}

/** KPIs del Funnel Venta. */
export interface VentaMetrics {
  revenue: number; // 1
  quotesSent: number; // 2
  /**
   * Pipeline $ ACTUAL — BRUTO, sin ponderar. SNAPSHOT del ahora: suma de
   * opps vivas en este momento. NO responde al filtro de fecha (solo al
   * de asesor). Comparable con el kanban del pipeline.
   */
  pipelineGrossNow: number;
  /**
   * Pipeline $ EN EL PERIODO — BRUTO. Suma de opps vivas CREADAS en el
   * periodo. SÍ responde al filtro de fecha. Definición simple (creada en
   * el periodo), sin reconstrucción histórica.
   */
  pipelineGrossPeriod: number;
  leads: number; // 4
  qualifiedLeads: number; // 5
  wonCount: number; // 6
  /**
   * Activas (con cotización) — SNAPSHOT del ahora: opps vivas con Draft
   * Order de Cotización en adelante. NO responde al filtro de fecha (solo
   * al de asesor). Coincide con el conteo del kanban del pipeline.
   */
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

/** KPIs del Funnel Post-venta. */
export interface PostventaMetrics {
  ordersCount: number; // pedidos creados en el periodo
  activeOrders: number; // órdenes distintas con opp post-venta viva ahora (snapshot)
  problematicCases: number;
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
  /**
   * Pipeline $ del vendedor — SNAPSHOT del ahora (comparable con el
   * kanban), NO el del periodo. Así la columna del desglose es
   * consistente con las tarjetas de "Estado actual".
   */
  pipelineGross: number;
  // Post-venta
  ordersCount: number;
  activeOrders: number;
  problematicCases: number;
}

/** Corte por canal del dashboard (F4). inbound = NOT outbound. */
export type Channel = "all" | "outbound" | "inbound";

export interface DashboardFiltersState {
  /** Preset activo, o "custom" si el usuario eligió un rango manual. */
  preset: PeriodPreset | "custom";
  /** Solo presente cuando preset === "custom". */
  customFrom: string | null;
  customTo: string | null;
  /** Solo admin: membership del asesor filtrado, null = todos. */
  advisorMembershipId: UUID | null;
  /** Canal activo (Todo/Outbound/Inbound). */
  channel: Channel;
}

/**
 * Snapshot completo que consume el dashboard (M8.2 ajuste #2: ya no hay
 * toggle de funnel — Venta y Post-venta se calculan y muestran juntos en
 * una sola pantalla). Ambas secciones comparten periodo y scope.
 */
export interface DashboardData {
  period: ResolvedPeriod;
  isAdmin: boolean;
  /** Canal activo aplicado a `venta`/`postventa`/breakdown (F4). */
  channel: Channel;
  /** Métricas del scope + canal activos (toda la org, o el asesor filtrado). */
  venta: VentaMetrics;
  postventa: PostventaMetrics;
  /** Comparativa outbound-vs-inbound (SIEMPRE ambos, para la tira). Respeta
   *  el scope activo, ignora el toggle de canal. */
  ventaByChannel: { outbound: VentaMetrics; inbound: VentaMetrics };
  postventaByChannel: { outbound: PostventaMetrics; inbound: PostventaMetrics };
  /** Drilldown por vendedor — solo admin y solo cuando no hay asesor filtrado. */
  ventaBreakdown: AdvisorBreakdownRow[] | null;
  postventaBreakdown: AdvisorBreakdownRow[] | null;
}
