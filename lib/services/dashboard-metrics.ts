import "server-only";
import {
  listDraftOppsCreatedInPeriod,
  listFullHistoryForOpportunities,
  listLivePipelineOpps,
  listLivePipelineSnapshot,
  listLivePostventaOpps,
  listLostEntriesInPeriod,
  listOrdersCreatedInPeriod,
  listPaidOrdersInPeriod,
  listProblematicCaseOpps,
  listStageEntriesInPeriod,
  listWonOppsInPeriod,
  type LivePipelineRow,
  type LivePostventaRow,
  type LostEntryRow,
  type StageEntryRow,
  type WonOppRow,
} from "@/lib/db/dashboard";
import { listLossReasons } from "@/lib/db/pipeline";
import { listRealVendorsForMapping } from "@/lib/db/users";
import {
  resolvePostventaStages,
  resolveVentaStageBoundaries,
  type PostventaStageInfo,
  type VentaStageBoundaries,
} from "@/lib/services/dashboard-stages";
import {
  daysBetween,
  monthKeyInTz,
  monthKeysInPeriod,
  monthLabel,
  type ResolvedPeriod,
} from "@/lib/time/period";
import type { UUID } from "@/lib/types/database";
import { channelOutboundValue } from "@/lib/types/dashboard";
import type {
  AdvisorBreakdownRow,
  Channel,
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

export type Scope = UUID | null | "all";

function matchScope(advisorId: UUID | null, scope: Scope): boolean {
  if (scope === "all") return true;
  if (scope === null) return advisorId === null;
  return advisorId === scope;
}

/**
 * Corte por CANAL (F4). Segundo eje de filtrado, ortogonal al scope
 * (asesor). `inbound = NOT outbound` (binario — decisión operador). Se
 * aplica junto a `matchScope` en cada agregación. Default "all" = sin corte.
 * (`Channel` se define en lib/types/dashboard.)
 */
function matchChannel(isOutbound: boolean, channel: Channel): boolean {
  const want = channelOutboundValue(channel);
  return want === null || isOutbound === want;
}

/** Las 3 métricas de meta (M2v2) para un scope. */
export interface ScopeAchievement {
  quotes: number; // cotizaciones enviadas (draft opps creadas en el periodo)
  won: number; // oportunidades ganadas
  amount: number; // monto vendido (orders pagadas)
}

/**
 * Tally de las TRES métricas de meta para un scope, desde las MISMAS fuentes
 * que el Dashboard. Definición ÚNICA de "qué cuenta como cotización / ganada
 * / monto": la usan `computeVentaMetrics` (KPIs del Dashboard) y
 * `computeGoalAchievement` (avance de metas), así no pueden divergir. Si esta
 * definición cambia, ambos lados se mueven juntos.
 */
export function tallyAchievement(
  paidOrders: VentaRaw["paidOrders"],
  draftOpps: VentaRaw["draftOpps"],
  wonOpps: VentaRaw["wonOpps"],
  scope: Scope,
  channel: Channel = "all",
): ScopeAchievement {
  let amount = 0;
  for (const o of paidOrders) {
    if (matchScope(o.assigned_advisor_id, scope) && matchChannel(o.is_outbound, channel))
      amount += Number(o.total_amount);
  }
  const quotes = draftOpps.filter(
    (d) => matchScope(d.assigned_advisor_id, scope) && matchChannel(d.is_outbound, channel),
  ).length;
  const won = wonOpps.filter(
    (w) => matchScope(w.assigned_advisor_id, scope) && matchChannel(w.is_outbound, channel),
  ).length;
  return { quotes, won, amount };
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
  /** Opps vivas CREADAS en el periodo → "Pipeline $ en el periodo". */
  livePipeline: LivePipelineRow[];
  /** Opps vivas AHORA (snapshot) → "Activas" + "Pipeline $ actual". */
  livePipelineSnapshot: LivePipelineRow[];
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
  liveOpps: LivePostventaRow[];
  postventaStages: PostventaStageInfo;
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

  const [
    paidOrders,
    draftOpps,
    wonOpps,
    livePipeline,
    livePipelineSnapshot,
    lostEntries,
    stageEntries,
    lossReasons,
  ] = await Promise.all([
      listPaidOrdersInPeriod(period.startUtc, period.endUtc),
      listDraftOppsCreatedInPeriod(period.startUtc, period.endUtc),
      listWonOppsInPeriod(period.startUtc, period.endUtc),
      listLivePipelineOpps(period.startUtc, period.endUtc),
      listLivePipelineSnapshot(),
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
    livePipelineSnapshot,
    lostEntries,
    stageEntries,
    maxNonLostPos,
    boundaries,
    lossReasonNames,
    period,
  };
}

export function computeVentaMetrics(
  raw: VentaRaw,
  scope: Scope,
  channel: Channel = "all",
): VentaMetrics {
  const { boundaries } = raw;

  // KPI1 Revenue + KPI2 Cotizaciones — tally compartido con las metas
  // (tallyAchievement = definición única de monto/cotizaciones/ganadas).
  const tally = tallyAchievement(raw.paidOrders, raw.draftOpps, raw.wonOpps, scope, channel);
  const revenue = tally.amount;
  const quotesSent = tally.quotes;

  // Serie de revenue por mes (bucketización; el total ya vino del tally).
  const monthRevenue = emptyMonths(raw.period);
  for (const o of raw.paidOrders) {
    if (!matchScope(o.assigned_advisor_id, scope) || !matchChannel(o.is_outbound, channel)) continue;
    if (o.paid_at) {
      const key = monthKeyInTz(o.paid_at);
      if (monthRevenue.has(key)) {
        monthRevenue.set(key, monthRevenue.get(key)! + Number(o.total_amount));
      }
    }
  }

  // Pipeline $ EN EL PERIODO (bruto) — opps vivas CREADAS en el periodo
  // (responde al filtro de fecha).
  let pipelineGrossPeriod = 0;
  for (const opp of raw.livePipeline) {
    if (!matchScope(opp.assigned_advisor_id, scope) || !matchChannel(opp.is_outbound, channel)) continue;
    const stage = boundaries.byId.get(opp.stage_id);
    if (!stage || stage.is_won || stage.is_lost) continue; // solo vivas
    pipelineGrossPeriod += amountOf(opp);
  }

  // SNAPSHOT del ahora (NO responde al filtro de fecha): Pipeline $ actual
  // (bruto) + Activas con cotización (Cotización en adelante). Misma
  // definición de "viva" que el kanban del pipeline → coinciden.
  let pipelineGrossNow = 0;
  let activeWithDraft = 0;
  for (const opp of raw.livePipelineSnapshot) {
    if (!matchScope(opp.assigned_advisor_id, scope) || !matchChannel(opp.is_outbound, channel)) continue;
    const stage = boundaries.byId.get(opp.stage_id);
    if (!stage || stage.is_won || stage.is_lost) continue; // solo vivas
    pipelineGrossNow += amountOf(opp);
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
    if (!matchScope(e.assigned_advisor_id, scope) || !matchChannel(e.is_outbound, channel)) continue;
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
  const wonScoped = raw.wonOpps.filter(
    (w) => matchScope(w.assigned_advisor_id, scope) && matchChannel(w.is_outbound, channel),
  );
  const wonCount = tally.won; // == wonScoped.length (misma definición vía tally)
  const cycleDays: number[] = [];
  for (const w of wonScoped) {
    // Sales cycle = de la creación REAL (effective_created_at: Draft
    // Order en Shopify si aplica, si no created_at) a la ganada REAL
    // (won_at re-fechado al pedido). Migración 0025.
    if (w.won_at) cycleDays.push(daysBetween(w.effective_created_at, w.won_at));
  }
  const salesCycleDays = cycleDays.length
    ? cycleDays.reduce((a, b) => a + b, 0) / cycleDays.length
    : null;

  // KPI8/10 Win/Loss rate + KPI11 Pérdidas por motivo.
  const lostScoped = raw.lostEntries.filter(
    (l) => matchScope(l.assigned_advisor_id, scope) && matchChannel(l.is_outbound, channel),
  );
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

  // KPI9 Win rate por etapa (solo etapas no terminales). M8.2 ajuste #8:
  // se muestra el % directo sin la etiqueta "Muestra pequeña"; el rate se
  // calcula siempre (null solo si la muestra es 0).
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
      return {
        stageId: s.id,
        stageName: s.name,
        position: s.position,
        sample,
        rate: rateOrNull(advanced, sample),
      };
    });

  return {
    revenue,
    quotesSent,
    pipelineGrossNow,
    pipelineGrossPeriod,
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
// Avance de metas (M2v2) — reuso de fuentes, sin recomputar
// ============================================================

/**
 * Las 3 métricas de meta por scope para un periodo (el mes en curso),
 * reusando las MISMAS fuentes del Dashboard (cancelled_at, effective_created_at,
 * draft-not-null, won_at, paid+paid_at viven en esas queries). LEAN: solo las
 * 3 consultas necesarias — NO trae pipeline/historial/postventa como
 * `computeDashboardData`, así Mi Día y el Dashboard pagan poco por las barras.
 * Devuelve un arreglo alineado con `scopes`.
 */
export async function computeGoalAchievement(
  period: ResolvedPeriod,
  scopes: Scope[],
): Promise<ScopeAchievement[]> {
  const [paidOrders, draftOpps, wonOpps] = await Promise.all([
    listPaidOrdersInPeriod(period.startUtc, period.endUtc),
    listDraftOppsCreatedInPeriod(period.startUtc, period.endUtc),
    listWonOppsInPeriod(period.startUtc, period.endUtc),
  ]);
  return scopes.map((s) => tallyAchievement(paidOrders, draftOpps, wonOpps, s));
}

// ============================================================
// Funnel Post-venta
// ============================================================

async function fetchPostventaRaw(period: ResolvedPeriod): Promise<PostventaRaw> {
  const postventaStages = await resolvePostventaStages();

  const [ordersCreated, problematicOpps, liveOpps] = await Promise.all([
    listOrdersCreatedInPeriod(period.startUtc, period.endUtc),
    postventaStages.problematicStage
      ? listProblematicCaseOpps(postventaStages.problematicStage.id)
      : Promise.resolve([]),
    listLivePostventaOpps(),
  ]);
  return { ordersCreated, problematicOpps, liveOpps, postventaStages, period };
}

export function computePostventaMetrics(
  raw: PostventaRaw,
  scope: Scope,
  channel: Channel = "all",
): PostventaMetrics {
  // Pedidos creados en el periodo (KPI base + serie por mes).
  const monthOrders = emptyMonths(raw.period);
  let ordersCount = 0;
  for (const o of raw.ordersCreated) {
    if (!matchScope(o.assigned_advisor_id, scope) || !matchChannel(o.is_outbound, channel)) continue;
    ordersCount += 1;
    // Bucket por la fecha real de creación en Shopify (migración 0024),
    // no por `created_at` de BD.
    const key = monthKeyInTz(o.shopify_created_at);
    if (monthOrders.has(key)) monthOrders.set(key, monthOrders.get(key)! + 1);
  }

  const problematicCases = raw.problematicOpps.filter(
    (p) => matchScope(p.assigned_advisor_id, scope) && matchChannel(p.is_outbound, channel),
  ).length;

  // Pedidos activos/vivos ahora (M8.2 ajuste #10): órdenes DISTINTAS con
  // al menos una opp post-venta abierta (no terminal). Dedupe por
  // `shopify_order_id`; opps sin orden ligada cuentan por su propio id.
  const terminal = raw.postventaStages.terminalStageIds;
  const activeOrderKeys = new Set<string>();
  for (const opp of raw.liveOpps) {
    if (!matchScope(opp.assigned_advisor_id, scope) || !matchChannel(opp.is_outbound, channel)) continue;
    if (terminal.has(opp.stage_id)) continue; // ya cerrada (ganada/perdida)
    activeOrderKeys.add(opp.shopify_order_id ?? `opp:${opp.id}`);
  }

  return {
    ordersCount,
    activeOrders: activeOrderKeys.size,
    problematicCases,
    ordersByMonth: monthsToSeries(monthOrders),
  };
}

// ============================================================
// Orquestador
// ============================================================

export interface ComputeDashboardInput {
  period: ResolvedPeriod;
  isAdmin: boolean;
  /** Scope activo:
   *  - undefined → toda la org (admin sin filtro; habilita drilldown).
   *  - "unassigned" → grupo "Sin asignar".
   *  - UUID → membership del vendedor (su propia vista) o el asesor filtrado.
   */
  scope?: UUID | "unassigned";
  /** Corte por canal del board completo (F4). Default "all". */
  channel?: Channel;
  organizationId: UUID;
}

/**
 * Calcula AMBOS funnels en una sola carga (M8.2 ajuste #2: sin toggle).
 * Cada funnel se fetchea una vez a nivel org y se agrega por scope; el
 * drilldown reusa el mismo dataset.
 */
export async function computeDashboardData(input: ComputeDashboardInput): Promise<DashboardData> {
  const scope: Scope =
    input.scope === undefined ? "all" : input.scope === "unassigned" ? null : input.scope;
  const channel: Channel = input.channel ?? "all";
  const wantBreakdown = input.isAdmin && input.scope === undefined;

  const [ventaRaw, postventaRaw] = await Promise.all([
    fetchVentaRaw(input.period),
    fetchPostventaRaw(input.period),
  ]);

  const venta = computeVentaMetrics(ventaRaw, scope, channel);
  const postventa = computePostventaMetrics(postventaRaw, scope, channel);

  // Tira comparativa outbound-vs-inbound (F4): SIEMPRE se calcula (no depende
  // del toggle de canal) para mostrar ambos lado a lado. Respeta el scope
  // (asesor) y el periodo activos.
  const ventaByChannel = {
    outbound: computeVentaMetrics(ventaRaw, scope, "outbound"),
    inbound: computeVentaMetrics(ventaRaw, scope, "inbound"),
  };
  const postventaByChannel = {
    outbound: computePostventaMetrics(postventaRaw, scope, "outbound"),
    inbound: computePostventaMetrics(postventaRaw, scope, "inbound"),
  };

  let ventaBreakdown: AdvisorBreakdownRow[] | null = null;
  let postventaBreakdown: AdvisorBreakdownRow[] | null = null;
  if (wantBreakdown) {
    const scopes = await breakdownScopes(input.organizationId);
    ventaBreakdown = scopes.map((s) =>
      breakdownRow(s, computeVentaMetrics(ventaRaw, s.membershipId, channel), null),
    );
    postventaBreakdown = scopes.map((s) =>
      breakdownRow(s, null, computePostventaMetrics(postventaRaw, s.membershipId, channel)),
    );
  }

  return {
    period: input.period,
    isAdmin: input.isAdmin,
    channel,
    venta,
    postventa,
    ventaByChannel,
    postventaByChannel,
    ventaBreakdown,
    postventaBreakdown,
  };
}

interface BreakdownScope {
  membershipId: UUID | null;
  name: string;
  color: string | null;
}

/**
 * Vendedores del drilldown: REALES (excluye Histórico — R10) + el grupo
 * "Sin asignar" (membershipId null).
 */
async function breakdownScopes(organizationId: UUID): Promise<BreakdownScope[]> {
  const vendors = await listRealVendorsForMapping(organizationId);
  return [
    ...vendors.map((v) => ({
      membershipId: v.id,
      name: v.profile.full_name,
      color: v.profile.color,
    })),
    { membershipId: null, name: "Sin asignar", color: null },
  ];
}

function breakdownRow(
  s: BreakdownScope,
  v: VentaMetrics | null,
  p: PostventaMetrics | null,
): AdvisorBreakdownRow {
  return {
    membershipId: s.membershipId,
    name: s.name,
    color: s.color,
    isUnassigned: s.membershipId === null,
    revenue: v?.revenue ?? 0,
    quotesSent: v?.quotesSent ?? 0,
    wonCount: v?.wonCount ?? 0,
    lostCount: v?.wonVsLost.lost ?? 0,
    winRate: v?.winRateGlobal ?? null,
    // Snapshot (actual), comparable con el kanban — consistente con las
    // tarjetas de "Estado actual".
    pipelineGross: v?.pipelineGrossNow ?? 0,
    ordersCount: p?.ordersCount ?? 0,
    activeOrders: p?.activeOrders ?? 0,
    problematicCases: p?.problematicCases ?? 0,
  };
}
