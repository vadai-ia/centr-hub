import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { fetchAllPaged as fetchAllPagedBase } from "@/lib/db/paginate";
import type { RangeableQuery } from "@/lib/db/paginate";
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
 *
 * TODAS pasan por `fetchAllPaged` — ver el porqué en su doc. Una query
 * suelta con `.limit(ROW_CAP)` NO trae 50k filas: el servidor corta antes
 * y en silencio.
 */

const ROW_CAP = 50000;

/** Atajo local: todas las lecturas de este módulo comparten el mismo cap. */
function fetchAllPaged<T>(build: () => RangeableQuery): Promise<T[]> {
  return fetchAllPagedBase<T>(build, ROW_CAP);
}

// ------------------------------------------------------------
// Filas crudas tipadas que devuelve cada query.
// ------------------------------------------------------------
/**
 * Fila cruda de pedido candidata a aportar venta en un periodo. La reparte el
 * módulo puro `revenue-recognition` (anticipo vs liquidación); esta capa solo
 * la trae. Lleva los campos que decide esa repartición: estado, etiquetas y
 * las dos fechas.
 */
export interface RevenueOrderRow {
  id: UUID;
  assigned_advisor_id: UUID | null;
  is_outbound: boolean;
  subtotal: string;
  paid_at: string | null;
  settled_at: string | null;
  financial_status: string;
  cancelled_at: string | null;
  shopify_tags: string[] | null;
  source: string | null;
}

/**
 * Porción de venta ya reconocida: lo que las métricas suman. `subtotal` es el
 * monto RECONOCIDO (el pedido completo, o solo su anticipo) y `paid_at` la
 * fecha con la que esa porción cae en su mes.
 */
export interface PaidOrderRow {
  assigned_advisor_id: UUID | null;
  is_outbound: boolean;
  /**
   * Monto que cuenta en TODA métrica de venta: el `subtotal_price` de Shopify
   * (productos con descuentos ya restados, sin envío). NUNCA el total del
   * pedido, que suma el envío. Ver `ERRORES.md` ("La venta se mide por subtotal").
   */
  subtotal: string;
  paid_at: string | null;
  /** `source_name` de Shopify: 'web' (tienda online) | 'shopify_draft_order'
   *  (cotización de un vendedor) | 'pos' | null. Distingue la venta ORGÁNICA
   *  (0051) — que NO es lo mismo que "sin asesor asignado". */
  source: string | null;
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
/** Cotización del periodo + si ya se ganó (para el % de cierre de cotizaciones). */
export interface DraftOppRow extends AdvisorOnlyRow {
  /** Fecha de ganada si esa cotización ya cerró; null si sigue viva o se perdió. */
  won_at: string | null;
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
  /** Contacto de la oportunidad: liga un lead con las compras de esa persona. */
  contact_id: UUID;
}
export interface HistoryStageRow {
  opportunity_id: UUID;
  to_stage_id: UUID;
}

// ============================================================
// Funnel Venta
// ============================================================

/**
 * Pedidos que pueden aportar venta al periodo (revenue, R5). El servicio los
 * parte en porciones con `recognitionSlices` — un pedido con etiqueta de
 * anticipo aporta su anticipo en el mes en que se procesó y el resto en el mes
 * en que se liquidó (0055), así que NO basta con buscar por `paid_at`.
 *
 * Dos ventanas, unidas por id:
 *   - `paid_at` en el periodo → el pedido (o su anticipo) entra aquí.
 *   - `settled_at` en el periodo → aquí cae la segunda mitad de un pedido
 *     procesado en un mes anterior.
 *
 * `cancelled_at IS NULL`: un pedido que Shopify revocó NO es venta, aunque
 * conserve `financial_status = 'paid'` (cancelar sin reembolsar no cambia ese
 * campo). Es la MISMA regla que ya aplicaban los indicadores del contacto
 * (`sumPaidOrdersForContact`). El filtro por estado NO vive aquí: lo decide
 * `recognitionSlices`, que admite un `pending` solo si declara anticipo.
 */
export async function listRevenueOrdersInPeriod(
  startUtc: string,
  endUtc: string,
): Promise<RevenueOrderRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const columns =
    "id, assigned_advisor_id, is_outbound, subtotal, paid_at, settled_at, " +
    "financial_status, cancelled_at, shopify_tags, source";
  const base = () =>
    supabase
      .from("orders")
      .select(columns)
      .eq("organization_id", organizationId)
      .is("cancelled_at", null);

  const [byProcessed, bySettled] = await Promise.all([
    fetchAllPaged<RevenueOrderRow>(() => base().gte("paid_at", startUtc).lte("paid_at", endUtc)),
    fetchAllPaged<RevenueOrderRow>(() =>
      base().gte("settled_at", startUtc).lte("settled_at", endUtc),
    ),
  ]);

  const byId = new Map<string, RevenueOrderRow>();
  for (const row of [...byProcessed, ...bySettled]) byId.set(row.id, row);
  return Array.from(byId.values());
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
): Promise<DraftOppRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  return fetchAllPaged<DraftOppRow>(() =>
    supabase
      .from("opportunities")
      .select("assigned_advisor_id, is_outbound, won_at")
      .eq("organization_id", organizationId)
      .eq("funnel", "venta")
      .is("cancelled_at", null)
      .not("shopify_draft_order_id", "is", null)
      .gte("effective_created_at", startUtc)
      .lte("effective_created_at", endUtc),
  );
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
  return fetchAllPaged<WonOppRow>(() =>
    supabase
      .from("opportunities")
      .select("assigned_advisor_id, is_outbound, effective_created_at, won_at, actual_amount, estimated_amount")
      .eq("organization_id", organizationId)
      .eq("funnel", "venta")
      .is("cancelled_at", null)
      .gte("won_at", startUtc)
      .lte("won_at", endUtc),
  );
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
  return fetchAllPaged<LivePipelineRow>(() =>
    supabase
      .from("opportunities")
      .select("assigned_advisor_id, is_outbound, stage_id, shopify_draft_order_id, actual_amount, estimated_amount")
      .eq("organization_id", organizationId)
      .eq("funnel", "venta")
      .is("cancelled_at", null)
      .is("won_at", null)
      .gte("effective_created_at", startUtc)
      .lte("effective_created_at", endUtc),
  );
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
 * `sinceUtc` (opcional) descarta las opps **SIN asesor** creadas antes de
 * esa fecha — corte por antigüedad configurable por organización
 * (`config.dashboard.pipeline_snapshot_since`, ver
 * `dashboard-snapshot-window.ts`). El corte NO toca a las opps asignadas:
 * el pipeline real de cada vendedor se muestra completo sin importar su
 * edad; lo que se poda es el arrastre histórico de "Sin asignar", que es
 * lo que nadie va a trabajar. Es además un corte SOLO del dashboard — el
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
  // "tiene asesor" OR "es reciente" — el complemento exacto de
  // "sin asesor Y vieja", que es lo único que se descarta.
  if (sinceUtc) {
    query = query.or(
      `assigned_advisor_id.not.is.null,effective_created_at.gte.${sinceUtc}`,
    );
  }
  return fetchAllPaged<LivePipelineRow>(() => {
    let q = supabase
      .from("opportunities")
      .select(
        "assigned_advisor_id, is_outbound, stage_id, shopify_draft_order_id, actual_amount, estimated_amount",
      )
      .eq("organization_id", organizationId)
      .eq("funnel", "venta")
      .is("cancelled_at", null)
      .is("won_at", null);
    if (sinceUtc) {
      q = q.or(
        `assigned_advisor_id.not.is.null,effective_created_at.gte.${sinceUtc}`,
      );
    }
    return q;
  });
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
  const data = await fetchAllPaged<unknown>(() =>
    supabase
      .from("opportunity_stage_history")
      .select(
        "opportunity_id, opportunity:opportunities!inner(assigned_advisor_id, is_outbound, actual_amount, estimated_amount, loss_reason_id, cancelled_at)",
      )
      .eq("organization_id", organizationId)
      .eq("to_stage_id", lostStageId)
      .is("opportunity.cancelled_at", null)
      .gte("effective_event_at", startUtc)
      .lte("effective_event_at", endUtc),
  );
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
  const data = await fetchAllPaged<unknown>(() =>
    supabase
      .from("opportunity_stage_history")
      .select(
        "opportunity_id, to_stage_id, opportunity:opportunities!inner(assigned_advisor_id, is_outbound, cancelled_at, contact_id)",
      )
      .eq("organization_id", organizationId)
      .in("to_stage_id", stageIds)
      .is("opportunity.cancelled_at", null)
      .gte("effective_event_at", startUtc)
      .lte("effective_event_at", endUtc),
  );
  type Raw = {
    opportunity_id: UUID;
    to_stage_id: UUID;
    opportunity: { assigned_advisor_id: UUID | null; is_outbound: boolean; contact_id: UUID };
  };
  return ((data ?? []) as unknown as Raw[]).map((r) => ({
    opportunity_id: r.opportunity_id,
    to_stage_id: r.to_stage_id,
    assigned_advisor_id: r.opportunity.assigned_advisor_id,
    is_outbound: r.opportunity.is_outbound,
    contact_id: r.opportunity.contact_id,
  }));
}

/**
 * Leads del periodo que se ARCHIVARON por absorción: entraron a "Lead nuevo"
 * y después se cancelaron porque el mismo contacto avanzó a cotización (ver
 * lib/services/opportunity-absorption.ts).
 *
 * Existe aparte de `listStageEntriesInPeriod` (que excluye canceladas) porque
 * esa exclusión, correcta para limpiar duplicados y pruebas, borraba del
 * conteo de leads justo a los que avanzaron. Medido en Centr, agosto 2026: 23
 * leads reales, 9 de ellos absorbidos — y 3 de los 4 que compraron estaban
 * entre esos 9.
 *
 * `cancellationSource` lo pasa el servicio (la constante es compartida con
 * quien cancela) para no acoplar la capa de datos a la de servicios.
 */
export async function listAbsorbedLeadEntriesInPeriod(
  initialStageId: UUID,
  cancellationSource: string,
  startUtc: string,
  endUtc: string,
): Promise<StageEntryRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const data = await fetchAllPaged<unknown>(() =>
    supabase
      .from("opportunity_stage_history")
      .select(
        "opportunity_id, to_stage_id, opportunity:opportunities!inner(assigned_advisor_id, is_outbound, contact_id, cancellation_source)",
      )
      .eq("organization_id", organizationId)
      .eq("to_stage_id", initialStageId)
      .eq("opportunity.cancellation_source", cancellationSource)
      .gte("effective_event_at", startUtc)
      .lte("effective_event_at", endUtc),
  );
  type Raw = {
    opportunity_id: UUID;
    to_stage_id: UUID;
    opportunity: { assigned_advisor_id: UUID | null; is_outbound: boolean; contact_id: UUID };
  };
  return ((data ?? []) as unknown as Raw[]).map((r) => ({
    opportunity_id: r.opportunity_id,
    to_stage_id: r.to_stage_id,
    assigned_advisor_id: r.opportunity.assigned_advisor_id,
    is_outbound: r.opportunity.is_outbound,
    contact_id: r.opportunity.contact_id,
  }));
}

export interface LeadPurchaseRow {
  contact_id: UUID;
  /** Subtotal del pedido (sin envío, con descuentos), igual que `PaidOrderRow`. */
  subtotal: string;
  paid_at: string | null;
}

/**
 * Pedidos PAGADOS de un conjunto de contactos desde `sinceUtc` — alimenta
 * "Leads que compraron": de los leads que entraron en el periodo, cuáles ya
 * generaron venta cobrada.
 *
 * Por CONTACTO y no por oportunidad a propósito: el lead nace como una opp en
 * "Lead nuevo" y la venta suele cerrarse en OTRA opp (la que crea la cotización
 * de Shopify), así que buscar `won_at` en la misma opp del lead contaría casi
 * cero. Lo que une ambas es la persona.
 *
 * Chunked por el tope de la cláusula IN y paginado por el tope de filas.
 */
export async function listPaidOrdersForContactsSince(
  contactIds: UUID[],
  sinceUtc: string,
): Promise<LeadPurchaseRow[]> {
  if (contactIds.length === 0) return [];
  const { supabase, organizationId } = getTenantScopedClient();
  const CHUNK = 300;
  const out: LeadPurchaseRow[] = [];
  for (let i = 0; i < contactIds.length; i += CHUNK) {
    const chunk = contactIds.slice(i, i + CHUNK);
    const page = await fetchAllPaged<LeadPurchaseRow>(() =>
      supabase
        .from("orders")
        .select("contact_id, subtotal, paid_at")
        .eq("organization_id", organizationId)
        .eq("financial_status", "paid")
        // Un pedido cancelado no es compra (misma regla que el KPI de venta).
        .is("cancelled_at", null)
        .in("contact_id", chunk)
        .gte("paid_at", sinceUtc),
    );
    out.push(...page);
  }
  return out;
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
    // Cada chunk se pagina también: 300 opps pueden traer entre todas
    // miles de filas de historial.
    const page = await fetchAllPaged<HistoryStageRow>(() =>
      supabase
        .from("opportunity_stage_history")
        .select("opportunity_id, to_stage_id")
        .eq("organization_id", organizationId)
        .in("opportunity_id", chunk),
    );
    out.push(...page);
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
  return fetchAllPaged<CreatedOrderRow>(() =>
    supabase
      .from("orders")
      .select("assigned_advisor_id, is_outbound, shopify_created_at")
      .eq("organization_id", organizationId)
      .gte("shopify_created_at", startUtc)
      .lte("shopify_created_at", endUtc),
  );
}

/** Post-venta KPI 2 — snapshot de opps en la etapa "Caso problemático". */
export async function listProblematicCaseOpps(
  problematicStageId: UUID,
): Promise<AdvisorOnlyRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  return fetchAllPaged<AdvisorOnlyRow>(() =>
    supabase
      .from("opportunities")
      .select("assigned_advisor_id, is_outbound")
      .eq("organization_id", organizationId)
      .eq("funnel", "post_venta")
      .eq("stage_id", problematicStageId)
      .is("cancelled_at", null),
  );
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
  return fetchAllPaged<LivePostventaRow>(() =>
    supabase
      .from("opportunities")
      .select("id, assigned_advisor_id, is_outbound, stage_id, shopify_order_id")
      .eq("organization_id", organizationId)
      .eq("funnel", "post_venta")
      .is("cancelled_at", null),
  );
}
