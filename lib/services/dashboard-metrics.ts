import "server-only";
import {
  listDraftOppsCreatedInPeriod,
  listFullHistoryForOpportunities,
  listLivePipelineOpps,
  listLostEntriesInPeriod,
  listOrderContactsSince,
  listOrdersCreatedInPeriod,
  listPaidOrdersInPeriod,
  listProblematicCaseOpps,
  listStageEntriesInPeriod,
  listWonOppsInPeriod,
  type LivePipelineRow,
  type LostEntryRow,
  type StageEntryRow,
  type WonOppRow,
} from "@/lib/db/dashboard";
import { listLossReasons } from "@/lib/db/pipeline";
import { listRealVendorsForMapping } from "@/lib/db/users";
import {
  resolveProblematicStage,
  resolveVentaStageBoundaries,
  type VentaStageBoundaries,
} from "@/lib/services/dashboard-stages";
import {
  daysBetween,
  monthKeyInTz,
  monthKeysInPeriod,
  monthLabel,
  type ResolvedPeriod,
} from "@/lib/time/period";
import { DASHBOARD_REPURCHASE_WINDOW_MONTHS, DASHBOARD_STAGE_WINRATE_MIN_SAMPLE } from "@/lib/constants";
import { DateTime } from "luxon";
import { TIMEZONE } from "@/lib/constants";
import type { Funnel, UUID } from "@/lib/types/database";
import type {
  AdvisorBreakdownRow,
  DashboardData,
  MonthValue,
  PostventaMetrics,
  StageWinRate,
  VentaMetrics,
} from "@/lib/types/dashboard";

/**
 * Servicio de cálculo de KPIs del Dashboard (M8.2). Fetchea los datos
 * a nivel org UNA vez y agrega por "scope" — así la vista-vendedor, la
 * vista-admin total y cada fila del drilldown reusan el mismo dataset.
 *
 * Scope:
 *   - UUID  → opps/orders de ese asesor (membership).
 *   - null  → grupo "Sin asignar" (assigned_advisor_id IS NULL).
 *   - "all" → toda la organización (incluye Histórico y Sin asignar).
 *
 * Histórico (R10): NO aparece como fila del drilldown, pero su revenue
 * y conteos SÍ suman en los totales de la org (scope "all"). Por eso la
 * suma de las filas del drilldown puede ser menor que el total org — la
 * diferencia es la contribución del usuario sistema Histórico.
 */

type Scope = UUID | null | "all";

function matchScope(advisorId: UUID | null, scope: Scope): boolean {
  if (scope === "all") return true;
  if (scope === null) return advisorId === null;
  return advisorId === scope;
}

function amountOf(row: { actual_amount: string | null; estimated_amount: string | null }): number {
  if (row.actual_amount !== null) return Number(row.actual_amount);
  if (row.estimated_amount !== null) return Number(row.estimated_amount);
  return 0;
}

function rateOrNull(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

// ------------------------------------------------------------
// Bundles de datos crudos (fetch único por funnel).
// ------------------------------------------------------------
export interface VentaRaw {
  paidOrders: Awaited<ReturnType<typeof listPaidOrdersInPeriod>>;
  draftOpps: Awaited<ReturnType<typeof listDraftOppsCreatedInPeriod>>;
  wonOpps: WonOppRow[];
  livePipeline: LivePipelineRow[];
  lostEntries: LostEntryRow[];
  stageEntries: StageEntryRow[];
  /** oppId → posición máxima NO-perdida alcanzada (para avance KPI9). */
  maxNonLostPos: Map<UUID, number>;
  boundaries: VentaStageBoundaries;
  lossReasonNames: Map<UUID, string>;
  period: ResolvedPeriod;
}

export interface PostventaRaw {
  ordersCreated: Awaited<ReturnType<typeof listOrdersCreatedInPeriod>>;
  problematicOpps: Awaited<ReturnType<typeof listProblematicCaseOpps>>;
  orderContacts: Awaited<ReturnType<typeof listOrderContactsSince>>;
  period: ResolvedPeriod;
}

function emptyMonths(period: ResolvedPeriod): Map<string, number> {
  const map = new Map<string, number>();
  for (const key of monthKeysInPeriod(period)) map.set(key, 0);
  return map;
}

function monthsToSeries(map: Map<string, number>): MonthValue[] {
  return Array.from(map.entries()).map(([monthKey, value]) => ({
    monthKey,
    label: monthLabel(monthKey),
    value,
  }));
}

// ============================================================
// Funnel Venta
// ============================================================

async function fetchVentaRaw(period: ResolvedPeriod): Promise<VentaRaw> {
  const boundaries = await resolveVentaStageBoundaries();
  const lostStageId = boundaries.lostStage?.id ?? null;

  const [paidOrders, draftOpps, wonOpps, livePipeline, lostEntries, stageEntries, lossReasons] =
    await Promise.all([
      listPaidOrdersInPeriod(period.startUtc, period.endUtc),
      listDraftOppsCreatedInPeriod(period.startUtc, period.endUtc),
      listWonOppsInPeriod(period.startUtc, period.endUtc),
      listLivePipelineOpps(),
      lostStageId
        ? listLostEntriesInPeriod(lostStageId, period.startUtc, period.endUtc)
        : Promise.resolve([] as LostEntryRow[]),
      listStageEntriesInPeriod(
        boundaries.stages.map((s) => s.id),
        period.startUtc,
        period.endUtc,
      ),
      listLossReasons(),
    ]);

  // Avance KPI9: histórico completo de las opps del cohort → posición
  // máxima NO-perdida alcanzada por cada una.
  const cohortIds = Array.from(new Set(stageEntries.map((e) => e.opportunity_id)));
  const fullHistory = await listFullHistoryForOpportunities(cohortIds);
  const maxNonLostPos = new Map<UUID, number>();
  for (const h of fullHistory) {
    const stage = boundaries.byId.get(h.to_stage_id);
    if (!stage || stage.is_lost) continue;
    const prev = maxNonLostPos.get(h.opportunity_id) ?? -Infinity;
    if (stage.position > prev) maxNonLostPos.set(h.opportunity_id, stage.position);
  }

  const lossReasonNames = new Map(lossReasons.map((r) => [r.id, r.name]));
  return {
    paidOrders,
    draftOpps,
    wonOpps,
    livePipeline,
    lostEntries,
    stageEntries,
    maxNonLostPos,
    boundaries,
    lossReasonNames,
    period,
  };
}

export function computeVentaMetrics(raw: VentaRaw, scope: Scope): VentaMetrics {
  const { boundaries } = raw;

  // KPI1 Revenue + serie por mes.
  const monthRevenue = emptyMonths(raw.period);
  let revenue = 0;
  for (const o of raw.paidOrders) {
    if (!matchScope(o.assigned_advisor_id, scope)) continue;
    const amt = Number(o.total_amount);
    revenue += amt;
    if (o.paid_at) {
      const key = monthKeyInTz(o.paid_at);
      if (monthRevenue.has(key)) monthRevenue.set(key, monthRevenue.get(key)! + amt);
    }
  }

  // KPI2 Cotizaciones enviadas.
  const quotesSent = raw.draftOpps.filter((d) => matchScope(d.assigned_advisor_id, scope)).length;

  // KPI3 Pipeline $ BRUTO + KPI7 activas con draft (de Cotización en adelante).
  let pipelineGross = 0;
  let activeWithDraft = 0;
  for (const opp of raw.livePipeline) {
    if (!matchScope(opp.assigned_advisor_id, scope)) continue;
    const stage = boundaries.byId.get(opp.stage_id);
    if (!stage || stage.is_won || stage.is_lost) continue; // solo vivas
    pipelineGross += amountOf(opp);
    if (opp.shopify_draft_order_id !== null && stage.position >= boundaries.cotizacionPosition) {
      activeWithDraft += 1;
    }
  }

  // KPI4 Leads + KPI5 Leads calificados (entradas distintas en periodo).
  const initialId = boundaries.initialStage?.id ?? null;
  const bandIds = new Set(boundaries.qualifiedBandStageIds);
  const leadOpps = new Set<UUID>();
  const qualifiedOpps = new Set<UUID>();
  // Cohort por etapa para KPI9.
  const cohortByStage = new Map<UUID, Set<UUID>>();
  for (const e of raw.stageEntries) {
    if (!matchScope(e.assigned_advisor_id, scope)) continue;
    if (initialId && e.to_stage_id === initialId) leadOpps.add(e.opportunity_id);
    if (bandIds.has(e.to_stage_id)) qualifiedOpps.add(e.opportunity_id);
    let set = cohortByStage.get(e.to_stage_id);
    if (!set) {
      set = new Set<UUID>();
      cohortByStage.set(e.to_stage_id, set);
    }
    set.add(e.opportunity_id);
  }

  // KPI6 Ganadas + KPI12 Sales cycle.
  const wonScoped = raw.wonOpps.filter((w) => matchScope(w.assigned_advisor_id, scope));
  const wonCount = wonScoped.length;
  const cycleDays: number[] = [];
  for (const w of wonScoped) {
    if (w.won_at) cycleDays.push(daysBetween(w.created_at, w.won_at));
  }
  const salesCycleDays = cycleDays.length
    ? cycleDays.reduce((a, b) => a + b, 0) / cycleDays.length
    : null;

  // KPI8/10 Win/Loss rate + KPI11 Pérdidas por motivo.
  const lostScoped = raw.lostEntries.filter((l) => matchScope(l.assigned_advisor_id, scope));
  const lostCount = lostScoped.length;
  const closed = wonCount + lostCount;
  const winRateGlobal = rateOrNull(wonCount, closed);
  const lossRate = rateOrNull(lostCount, closed);

  const byReason = new Map<string, { reasonId: UUID | null; count: number; amount: number }>();
  for (const l of lostScoped) {
    const key = l.loss_reason_id ?? "__none__";
    const entry = byReason.get(key) ?? { reasonId: l.loss_reason_id, count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += amountOf(l);
    byReason.set(key, entry);
  }
  const lossesByReason = Array.from(byReason.values())
    .map((e) => ({
      reasonId: e.reasonId,
      reasonName: e.reasonId ? raw.lossReasonNames.get(e.reasonId) ?? "Motivo desconocido" : "Sin motivo",
      count: e.count,
      amount: e.amount,
    }))
    .sort((a, b) => b.count - a.count);

  // KPI9 Win rate por etapa (solo etapas no terminales).
  const winRateByStage: StageWinRate[] = boundaries.stages
    .filter((s) => !s.is_won && !s.is_lost)
    .sort((a, b) => a.position - b.position)
    .map((s) => {
      const cohort = cohortByStage.get(s.id) ?? new Set<UUID>();
      const sample = cohort.size;
      let advanced = 0;
      Array.from(cohort).forEach((oppId) => {
        const maxPos = raw.maxNonLostPos.get(oppId) ?? -Infinity;
        if (maxPos > s.position) advanced += 1;
      });
      const smallSample = sample < DASHBOARD_STAGE_WINRATE_MIN_SAMPLE;
      return {
        stageId: s.id,
        stageName: s.name,
        position: s.position,
        sample,
        rate: smallSample ? null : rateOrNull(advanced, sample),
        smallSample,
      };
    });

  return {
    revenue,
    quotesSent,
    pipelineGross,
    leads: leadOpps.size,
    qualifiedLeads: qualifiedOpps.size,
    wonCount,
    activeWithDraft,
    winRateGlobal,
    winRateByStage,
    lossRate,
    lossesByReason,
    salesCycleDays,
    revenueByMonth: monthsToSeries(monthRevenue),
    wonVsLost: { won: wonCount, lost: lostCount },
  };
}

// ============================================================
// Funnel Post-venta
// ============================================================

async function fetchPostventaRaw(period: ResolvedPeriod): Promise<PostventaRaw> {
  const problematicStage = await resolveProblematicStage();
  const windowStart = DateTime.now()
    .setZone(TIMEZONE)
    .minus({ months: DASHBOARD_REPURCHASE_WINDOW_MONTHS })
    .startOf("day")
    .toUTC()
    .toISO()!;

  const [ordersCreated, problematicOpps, orderContacts] = await Promise.all([
    listOrdersCreatedInPeriod(period.startUtc, period.endUtc),
    problematicStage ? listProblematicCaseOpps(problematicStage.id) : Promise.resolve([]),
    listOrderContactsSince(windowStart),
  ]);
  return { ordersCreated, problematicOpps, orderContacts, period };
}

export function computePostventaMetrics(raw: PostventaRaw, scope: Scope): PostventaMetrics {
  const monthOrders = emptyMonths(raw.period);
  let ordersCount = 0;
  for (const o of raw.ordersCreated) {
    if (!matchScope(o.assigned_advisor_id, scope)) continue;
    ordersCount += 1;
    const key = monthKeyInTz(o.created_at);
    if (monthOrders.has(key)) monthOrders.set(key, monthOrders.get(key)! + 1);
  }

  const problematicCases = raw.problematicOpps.filter((p) =>
    matchScope(p.assigned_advisor_id, scope),
  ).length;

  // Tasa de recompra: clientes con >1 order en la ventana fija de 12 meses.
  const perContact = new Map<UUID, number>();
  for (const r of raw.orderContacts) {
    if (!matchScope(r.assigned_advisor_id, scope)) continue;
    perContact.set(r.contact_id, (perContact.get(r.contact_id) ?? 0) + 1);
  }
  const base = perContact.size;
  let repurchasers = 0;
  Array.from(perContact.values()).forEach((count) => {
    if (count > 1) repurchasers += 1;
  });
  const repurchaseRate = rateOrNull(repurchasers, base);

  return {
    ordersCount,
    problematicCases,
    repurchaseRate,
    ordersByMonth: monthsToSeries(monthOrders),
  };
}

// ============================================================
// Orquestador
// ============================================================

export interface ComputeDashboardInput {
  funnel: Funnel;
  period: ResolvedPeriod;
  isAdmin: boolean;
  /** Scope activo:
   *  - undefined → toda la org (admin sin filtro; habilita drilldown).
   *  - "unassigned" → grupo "Sin asignar".
   *  - UUID → membership del vendedor (su propia vista) o el asesor filtrado.
   */
  scope?: UUID | "unassigned";
  organizationId: UUID;
}

export async function computeDashboardData(input: ComputeDashboardInput): Promise<DashboardData> {
  const scope: Scope =
    input.scope === undefined ? "all" : input.scope === "unassigned" ? null : input.scope;
  const wantBreakdown = input.isAdmin && input.scope === undefined;

  let venta: VentaMetrics | null = null;
  let postventa: PostventaMetrics | null = null;
  let advisorBreakdown: AdvisorBreakdownRow[] | null = null;

  if (input.funnel === "venta") {
    const raw = await fetchVentaRaw(input.period);
    venta = computeVentaMetrics(raw, scope);
    if (wantBreakdown) {
      advisorBreakdown = await buildBreakdown(input.organizationId, raw, null);
    }
  } else {
    const raw = await fetchPostventaRaw(input.period);
    postventa = computePostventaMetrics(raw, scope);
    if (wantBreakdown) {
      advisorBreakdown = await buildBreakdown(input.organizationId, null, raw);
    }
  }

  return {
    funnel: input.funnel,
    period: input.period,
    isAdmin: input.isAdmin,
    venta,
    postventa,
    advisorBreakdown,
  };
}

/**
 * Drilldown por vendedor. Itera vendedores REALES (excluye Histórico —
 * R10) + el grupo "Sin asignar" (membershipId null). Solo se llena el
 * funnel activo; el otro queda en cero.
 */
async function buildBreakdown(
  organizationId: UUID,
  ventaRaw: VentaRaw | null,
  postventaRaw: PostventaRaw | null,
): Promise<AdvisorBreakdownRow[]> {
  const vendors = await listRealVendorsForMapping(organizationId);
  const scopes: Array<{ membershipId: UUID | null; name: string; color: string | null }> = [
    ...vendors.map((v) => ({
      membershipId: v.id,
      name: v.profile.full_name,
      color: v.profile.color,
    })),
    { membershipId: null, name: "Sin asignar", color: null },
  ];

  return scopes.map(({ membershipId, name, color }) => {
    const scope: Scope = membershipId;
    const v = ventaRaw ? computeVentaMetrics(ventaRaw, scope) : null;
    const p = postventaRaw ? computePostventaMetrics(postventaRaw, scope) : null;
    return {
      membershipId,
      name,
      color,
      isUnassigned: membershipId === null,
      revenue: v?.revenue ?? 0,
      quotesSent: v?.quotesSent ?? 0,
      wonCount: v?.wonCount ?? 0,
      lostCount: v?.wonVsLost.lost ?? 0,
      winRate: v?.winRateGlobal ?? null,
      pipelineGross: v?.pipelineGross ?? 0,
      ordersCount: p?.ordersCount ?? 0,
      problematicCases: p?.problematicCases ?? 0,
    };
  });
}
