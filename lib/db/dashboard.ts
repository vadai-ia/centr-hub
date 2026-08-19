import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import type { UUID } from "@/lib/types/database";

/**
 * Capa de datos del Dashboard (M8.2). TODAS las agregaciones corren
 * contra la BD interna, NUNCA contra Shopify (decisión arquitectónica:
 * si la BD diverge de Shopify es bug de sync M3, no se compensa aquí).
 *
 * Las queries fetchean a nivel organización (sin filtro de asesor en
 * el SQL) y el servicio agrega/filtra por scope. Razón: el drilldown
 * por vendedor (admin) necesita TODAS las filas con su asesor; reusar
 * la misma query para vista-vendedor evita duplicar caminos. Cap
 * defensivo de 50k filas como circuit breaker (patrón M5/M6).
 */

const ROW_CAP = 50000;

// ------------------------------------------------------------
// Filas crudas tipadas que devuelve cada query.
// ------------------------------------------------------------
export interface PaidOrderRow {
  assigned_advisor_id: UUID | null;
  is_outbound: boolean;
  total_amount: string;
  paid_at: string | null;
}
export interface CreatedOrderRow {
  assigned_advisor_id: UUID | null;
  is_outbound: boolean;
  /**
   * Fecha real de creación del pedido en Shopify (migración 0024). El
   * dashboard cuenta/agrupa pedidos por esta fecha, NO por `created_at`
   * de BD (que es cuándo el registro entró localmente). La query filtra
   * por este campo, así que las filas con NULL (pre-correctivo) quedan
   * fuera del periodo.
   */
  shopify_created_at: string;
}
export interface AdvisorOnlyRow {
  assigned_advisor_id: UUID | null;
  is_outbound: boolean;
}
export interface WonOppRow {
  assigned_advisor_id: UUID | null;
  is_outbound: boolean;
  /**
   * Fecha efectiva de creación (COALESCE(shopify_created_at, created_at),
   * migración 0025) — inicio del Sales cycle. Para opps de Shopify es la
   * creación del Draft Order; para nacidas en plataforma, su created_at.
   */
  effective_created_at: string;
  won_at: string | null;
  actual_amount: string | null;
  estimated_amount: string | null;
}
export interface LivePipelineRow {
  assigned_advisor_id: UUID | null;
  is_outbound: boolean;
  stage_id: UUID;
  shopify_draft_order_id: string | null;
  actual_amount: string | null;
  estimated_amount: string | null;
}
export interface LivePostventaRow {
  id: UUID;
  assigned_advisor_id: UUID | null;
  is_outbound: boolean;
  stage_id: UUID;
  shopify_order_id: string | null;
}
export interface LostEntryRow {
  opportunity_id: UUID;
  assigned_advisor_id: UUID | null;
  is_outbound: boolean;
  actual_amount: string | null;
  estimated_amount: string | null;
  loss_reason_id: UUID | null;
}
export interface StageEntryRow {
  opportunity_id: UUID;
  to_stage_id: UUID;
  assigned_advisor_id: UUID | null;
  is_outbound: boolean;
}
export interface HistoryStageRow {
  opportunity_id: UUID;
  to_stage_id: UUID;
}

// ============================================================
// Funnel Venta
// ============================================================

/** KPI 1 — órdenes pagadas con paid_at en el periodo (revenue, R5). */
export async function listPaidOrdersInPeriod(
  startUtc: string,
  endUtc: string,
): Promise<PaidOrderRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("orders")
    .select("assigned_advisor_id, is_outbound, total_amount, paid_at")
    .eq("organization_id", organizationId)
    .eq("financial_status", "paid")
    .gte("paid_at", startUtc)
    .lte("paid_at", endUtc)
    .limit(ROW_CAP);
  if (error) throw error;
  return (data ?? []) as PaidOrderRow[];
}

/**
 * KPI 2 — opps de venta con draft ligada creadas en el periodo, por la
 * fecha REAL de creación en Shopify (`effective_created_at` =
 * COALESCE(shopify_created_at, created_at), migración 0025), no por
 * `created_at` de BD (fecha de importación).
 */
export async function listDraftOppsCreatedInPeriod(
  startUtc: string,
  endUtc: string,
): Promise<AdvisorOnlyRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("assigned_advisor_id, is_outbound")
    .eq("organization_id", organizationId)
    .eq("funnel", "venta")
    .is("cancelled_at", null)
    .not("shopify_draft_order_id", "is", null)
    .gte("effective_created_at", startUtc)
    .lte("effective_created_at", endUtc)
    .limit(ROW_CAP);
  if (error) throw error;
  return (data ?? []) as AdvisorOnlyRow[];
}

/**
 * KPIs 6/8/12 — opps de venta con won_at en el periodo. `won_at` es la
 * fecha REAL de ganada: el trigger F1→F2 la puebla desde la fecha del
 * pedido en Shopify y el correctivo re-fechó las importadas (migración
 * 0025), así que ya no es la fecha de importación.
 */
export async function listWonOppsInPeriod(
  startUtc: string,
  endUtc: string,
): Promise<WonOppRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("assigned_advisor_id, is_outbound, effective_created_at, won_at, actual_amount, estimated_amount")
    .eq("organization_id", organizationId)
    .eq("funnel", "venta")
    .is("cancelled_at", null)
    .gte("won_at", startUtc)
    .lte("won_at", endUtc)
    .limit(ROW_CAP);
  if (error) throw error;
  return (data ?? []) as WonOppRow[];
}

/**
 * "Pipeline $ en el periodo" — opps de venta vivas (no
 * ganadas/perdidas/canceladas) CREADAS en el periodo, por la fecha REAL
 * de creación (`effective_created_at`, migración 0025), no por created_at
 * de BD. Definición simple "creada en el periodo y viva", sin
 * reconstrucción de estado histórico (Ajuste métricas estado vs periodo).
 * `won_at IS NULL` excluye ganadas en SQL; las perdidas se filtran por
 * etapa en el servicio.
 *
 * OJO: esta query SÍ responde al filtro de fecha. El conteo de "Activas"
 * y "Pipeline $ actual" (snapshot del ahora) NO usa esta query — usa
 * `listLivePipelineSnapshot` (sin fecha). Ver Ajuste métricas estado vs
 * periodo + `ERRORES.md`.
 */
export async function listLivePipelineOpps(
  startUtc: string,
  endUtc: string,
): Promise<LivePipelineRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("assigned_advisor_id, is_outbound, stage_id, shopify_draft_order_id, actual_amount, estimated_amount")
    .eq("organization_id", organizationId)
    .eq("funnel", "venta")
    .is("cancelled_at", null)
    .is("won_at", null)
    .gte("effective_created_at", startUtc)
    .lte("effective_created_at", endUtc)
    .limit(ROW_CAP);
  if (error) throw error;
  return (data ?? []) as LivePipelineRow[];
}

/**
 * "Activas (con cotización)" + "Pipeline $ actual" — SNAPSHOT del ahora.
 * Opps de venta vivas (no ganadas/perdidas/canceladas) SIN filtro de
 * fecha: refleja lo que está vivo en este momento, igual que el kanban
 * del pipeline (`listKanbanOpportunities`: `cancelled_at IS NULL`,
 * funnel venta, etapa no terminal). El servicio filtra por scope (asesor)
 * y excluye etapas terminales por flag (`is_won`/`is_lost`).
 *
 * Misma forma y mismo costo que `listLivePipelineOpps`, pero sin las dos
 * cláusulas de fecha — por eso coincide con el conteo del kanban (que
 * tampoco filtra por fecha de creación por default). Resuelve la
 * inconsistencia "kanban 4 vs dashboard 2" (Ajuste métricas estado vs
 * periodo). `won_at IS NULL` excluye ganadas en SQL.
 *
 * `sinceUtc` (opcional) acota el snapshot a lo creado DESDE esa fecha —
 * corte por antigüedad configurable por organización
 * (`config.dashboard.pipeline_snapshot_since`, ver
 * `dashboard-snapshot-window.ts`). Es un corte SOLO del dashboard: el
 * kanban no lo aplica, así que con la config puesta las dos vistas
 * divergen a propósito. Sin `sinceUtc` la query queda idéntica a la
 * original y ambas vistas vuelven a coincidir.
 */
export async function listLivePipelineSnapshot(
  sinceUtc?: string | null,
): Promise<LivePipelineRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("opportunities")
    .select("assigned_advisor_id, is_outbound, stage_id, shopify_draft_order_id, actual_amount, estimated_amount")
    .eq("organization_id", organizationId)
    .eq("funnel", "venta")
    .is("cancelled_at", null)
    .is("won_at", null);
  if (sinceUtc) query = query.gte("effective_created_at", sinceUtc);
  const { data, error } = await query.limit(ROW_CAP);
  if (error) throw error;
  return (data ?? []) as LivePipelineRow[];
}

/**
 * KPIs 8/10/11 — opps que entraron a la etapa "Perdida" en el periodo
 * (vía histórico). Embed `!inner` sobre opportunities para traer asesor,
 * montos y motivo, y excluir canceladas (cancelado ≠ perdido — R5).
 */
export async function listLostEntriesInPeriod(
  lostStageId: UUID,
  startUtc: string,
  endUtc: string,
): Promise<LostEntryRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunity_stage_history")
    .select(
      "opportunity_id, opportunity:opportunities!inner(assigned_advisor_id, is_outbound, actual_amount, estimated_amount, loss_reason_id, cancelled_at)",
    )
    .eq("organization_id", organizationId)
    .eq("to_stage_id", lostStageId)
    .is("opportunity.cancelled_at", null)
    .gte("effective_event_at", startUtc)
    .lte("effective_event_at", endUtc)
    .limit(ROW_CAP);
  if (error) throw error;
  type Raw = {
    opportunity_id: UUID;
    opportunity: {
      assigned_advisor_id: UUID | null;
      is_outbound: boolean;
      actual_amount: string | null;
      estimated_amount: string | null;
      loss_reason_id: UUID | null;
    };
  };
  const seen = new Set<UUID>();
  const out: LostEntryRow[] = [];
  for (const r of (data ?? []) as unknown as Raw[]) {
    if (seen.has(r.opportunity_id)) continue;
    seen.add(r.opportunity_id);
    out.push({
      opportunity_id: r.opportunity_id,
      assigned_advisor_id: r.opportunity.assigned_advisor_id,
      is_outbound: r.opportunity.is_outbound,
      actual_amount: r.opportunity.actual_amount,
      estimated_amount: r.opportunity.estimated_amount,
      loss_reason_id: r.opportunity.loss_reason_id,
    });
  }
  return out;
}

/**
 * KPIs 4/5/9 — entradas a un conjunto de etapas en el periodo (vía
 * histórico). Una opp puede aparecer varias veces (entró a varias
 * etapas del set); el servicio dedupe por métrica. Excluye canceladas.
 */
export async function listStageEntriesInPeriod(
  stageIds: UUID[],
  startUtc: string,
  endUtc: string,
): Promise<StageEntryRow[]> {
  if (stageIds.length === 0) return [];
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunity_stage_history")
    .select(
      "opportunity_id, to_stage_id, opportunity:opportunities!inner(assigned_advisor_id, is_outbound, cancelled_at)",
    )
    .eq("organization_id", organizationId)
    .in("to_stage_id", stageIds)
    .is("opportunity.cancelled_at", null)
    .gte("effective_event_at", startUtc)
    .lte("effective_event_at", endUtc)
    .limit(ROW_CAP);
  if (error) throw error;
  type Raw = {
    opportunity_id: UUID;
    to_stage_id: UUID;
    opportunity: { assigned_advisor_id: UUID | null; is_outbound: boolean };
  };
  return ((data ?? []) as unknown as Raw[]).map((r) => ({
    opportunity_id: r.opportunity_id,
    to_stage_id: r.to_stage_id,
    assigned_advisor_id: r.opportunity.assigned_advisor_id,
    is_outbound: r.opportunity.is_outbound,
  }));
}

/**
 * KPI 9 (advance) — histórico COMPLETO (no acotado al periodo) de un
 * conjunto de opps, para saber a qué posición máxima de etapa llegaron
 * cada una (¿avanzó más allá de la etapa S?). Chunked por el cap de
 * la cláusula IN.
 */
export async function listFullHistoryForOpportunities(
  opportunityIds: UUID[],
): Promise<HistoryStageRow[]> {
  if (opportunityIds.length === 0) return [];
  const { supabase, organizationId } = getTenantScopedClient();
  const CHUNK = 300;
  const out: HistoryStageRow[] = [];
  for (let i = 0; i < opportunityIds.length; i += CHUNK) {
    const chunk = opportunityIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("opportunity_stage_history")
      .select("opportunity_id, to_stage_id")
      .eq("organization_id", organizationId)
      .in("opportunity_id", chunk)
      .limit(ROW_CAP);
    if (error) throw error;
    out.push(...((data ?? []) as HistoryStageRow[]));
  }
  return out;
}

// ============================================================
// Funnel Post-venta
// ============================================================

/**
 * Post-venta KPI 1 — órdenes CREADAS en el periodo, por la fecha real
 * de creación en Shopify (`shopify_created_at`, migración 0024), NO por
 * `created_at` de BD. Definición de negocio: cuenta pagados + pendientes
 * por igual (sin filtro de `financial_status`). Las filas con
 * `shopify_created_at` NULL (pre-correctivo o pedido inexistente en
 * Shopify) quedan fuera de cualquier periodo — una fecha desconocida no
 * se inventa.
 */
export async function listOrdersCreatedInPeriod(
  startUtc: string,
  endUtc: string,
): Promise<CreatedOrderRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("orders")
    .select("assigned_advisor_id, is_outbound, shopify_created_at")
    .eq("organization_id", organizationId)
    .gte("shopify_created_at", startUtc)
    .lte("shopify_created_at", endUtc)
    .limit(ROW_CAP);
  if (error) throw error;
  return (data ?? []) as CreatedOrderRow[];
}

/** Post-venta KPI 2 — snapshot de opps en la etapa "Caso problemático". */
export async function listProblematicCaseOpps(
  problematicStageId: UUID,
): Promise<AdvisorOnlyRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("assigned_advisor_id, is_outbound")
    .eq("organization_id", organizationId)
    .eq("funnel", "post_venta")
    .eq("stage_id", problematicStageId)
    .is("cancelled_at", null)
    .limit(ROW_CAP);
  if (error) throw error;
  return (data ?? []) as AdvisorOnlyRow[];
}

/**
 * Post-venta KPI 3 (M8.2 ajuste #10) — snapshot de opps post-venta NO
 * canceladas, con su etapa y la orden de origen (`shopify_order_id`),
 * para contar "Pedidos activos/vivos ahora en Post-venta" = órdenes
 * distintas con al menos una opp post-venta abierta (el servicio filtra
 * etapas terminales y dedupe por orden). Snapshot puro: NO se acota al
 * periodo (es "ahora", no "creados en el periodo").
 */
export async function listLivePostventaOpps(): Promise<LivePostventaRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("id, assigned_advisor_id, is_outbound, stage_id, shopify_order_id")
    .eq("organization_id", organizationId)
    .eq("funnel", "post_venta")
    .is("cancelled_at", null)
    .limit(ROW_CAP);
  if (error) throw error;
  return (data ?? []) as LivePostventaRow[];
}
