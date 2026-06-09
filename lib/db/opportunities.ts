import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import type {
  Funnel,
  OpportunityLineItemRow,
  OpportunityRow,
  OpportunityStageHistoryRow,
  StageHistoryContext,
  Database,
  UUID,
} from "@/lib/types/database";

type OppInsert = Database["public"]["Tables"]["opportunities"]["Insert"];
type OppUpdate = Database["public"]["Tables"]["opportunities"]["Update"];
type OppLineInsert =
  Database["public"]["Tables"]["opportunity_line_items"]["Insert"];

// ============================================================
// opportunities
// ============================================================

export async function getOpportunityById(id: UUID): Promise<OpportunityRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/**
 * Resuelve la oportunidad por Draft Order ID. Incluye canceladas
 * intencionalmente — el UNIQUE constraint `(organization_id,
 * shopify_draft_order_id)` garantiza ≤1 fila, y los workers de
 * M3 necesitan poder encontrarla aunque esté cancelada (caso edge:
 * Shopify reactiva un DO previamente borrado).
 */
export async function findOpportunityByDraftOrderId(
  draftOrderId: string,
): Promise<OpportunityRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("shopify_draft_order_id", draftOrderId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/**
 * Resuelve el id de la hija de Post-venta de una F1 dada (su
 * `parent_opportunity_id`). El trigger F1→F2 crea como máximo una hija
 * por F1 (guard `child_already_exists`), así que ≤1 fila. Incluye
 * canceladas: el hook de re-atribución de orders/* puede necesitar
 * alinear el asesor aunque la hija esté cancelada (consistencia de
 * auditoría). Devuelve null si la F1 aún no tiene hija.
 */
export async function findPostventaChildOpportunityId(
  parentOpportunityId: UUID,
): Promise<UUID | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("parent_opportunity_id", parentOpportunityId)
    .eq("funnel", "post_venta")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data?.id as UUID) ?? null;
}

export async function createOpportunity(
  input: Omit<OppInsert, "organization_id">,
): Promise<OpportunityRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .insert({ ...input, organization_id: organizationId })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function updateOpportunity(
  id: UUID,
  patch: OppUpdate,
): Promise<OpportunityRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/**
 * Lista oportunidades del pipeline. Filtro de cancelación
 * (cancelado ≠ perdido — Sección 3.3.4 + R5):
 *   - default: solo ACTIVAS (cancelled_at IS NULL). Cubre kanban
 *     (M5), detalle de contacto (M6), métricas operativas del
 *     vendedor.
 *   - `includeCancelled: true` → trae activas + canceladas. Útil
 *     para vistas de auditoría que mezclan ambas.
 *   - `onlyCancelled: true` → solo canceladas. Útil para vista
 *     explícita "ver cancelaciones administrativas". Ignora
 *     `includeCancelled` si se pasa.
 *
 * Las canceladas se EXCLUYEN del win rate por defecto — el
 * dashboard de M10 debe usar el default (sin override) para que
 * el denominador (Ganadas + Perdidas) no se contamine.
 */
export async function listOpportunities(opts: {
  funnel?: Funnel;
  stageId?: UUID;
  contactId?: UUID;
  assignedAdvisorId?: UUID | null;
  includeCancelled?: boolean;
  onlyCancelled?: boolean;
  limit?: number;
} = {}): Promise<OpportunityRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("opportunities")
    .select("*")
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false });

  if (opts.funnel) query = query.eq("funnel", opts.funnel);
  if (opts.stageId) query = query.eq("stage_id", opts.stageId);
  if (opts.contactId) query = query.eq("contact_id", opts.contactId);
  if (opts.assignedAdvisorId !== undefined) {
    if (opts.assignedAdvisorId === null) query = query.is("assigned_advisor_id", null);
    else query = query.eq("assigned_advisor_id", opts.assignedAdvisorId);
  }

  if (opts.onlyCancelled) {
    query = query.not("cancelled_at", "is", null);
  } else if (!opts.includeCancelled) {
    query = query.is("cancelled_at", null);
  }

  if (opts.limit) query = query.limit(opts.limit);

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

// ============================================================
// Kanban (M5) — opp + contact embebido para card minimalista
// ============================================================

/**
 * Subset del contact embebido que necesita la card del kanban.
 * El popup de detalle de M6 reutiliza el mismo shape (sin fetch
 * adicional al abrir la card desde una lista ya cargada).
 */
export interface KanbanContactEmbed {
  id: UUID;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  shopify_customer_id: string | null;
  whaapy_contact_id: string | null;
  shopify_tags: string[];
}

/**
 * Fila de opp tal como la consume el kanban (M5). Incluye el contact
 * embebido para que la card no requiera fetch adicional. El popup
 * único de detalle (M6) reutiliza el mismo shape como punto de
 * partida cuando se abre desde una card ya cargada.
 */
export interface KanbanOpportunity {
  id: UUID;
  organization_id: UUID;
  funnel: Funnel;
  stage_id: UUID;
  contact_id: UUID;
  assigned_advisor_id: UUID | null;
  shopify_draft_order_id: string | null;
  shopify_order_id: string | null;
  display_reference: string | null;
  actual_amount: string | null;
  estimated_amount: string | null;
  currency: string;
  updated_at: string;
  last_modified_at: string;
  last_modified_source: string;
  cancelled_at: string | null;
  contact: KanbanContactEmbed | null;
}

const KANBAN_OPPORTUNITY_SELECT = `
  id,
  organization_id,
  funnel,
  stage_id,
  contact_id,
  assigned_advisor_id,
  shopify_draft_order_id,
  shopify_order_id,
  display_reference,
  actual_amount,
  estimated_amount,
  currency,
  updated_at,
  last_modified_at,
  last_modified_source,
  cancelled_at,
  contact:contacts!inner (
    id,
    full_name,
    phone,
    email,
    shopify_customer_id,
    whaapy_contact_id,
    shopify_tags
  )
`;

/**
 * Lista paginada de oportunidades activas para el kanban M5.
 *
 * Reglas críticas (CLAUDE.md "Cancelación de oportunidades"):
 *  - Default excluye canceladas (cancelled_at IS NULL).
 *  - El filtro de tenant explícito (organization_id) es la
 *    barrera dura — no fiarse solo de RLS dado que el cliente
 *    admin bypassea RLS (Sección 3.7 + R6).
 *  - Para vendedor pasar `assignedAdvisorId = membershipId`.
 *  - Para admin con filtro "Sin asignar" pasar `assignedAdvisorId = null`.
 *  - Para admin sin filtro pasar `assignedAdvisorId = undefined`.
 *
 * Filtros adicionales (lote de polish M6 + correcciones ronda 2):
 *  - `dateFrom`/`dateTo` filtran por `created_at` (rango inclusivo) —
 *    la fecha que el usuario percibe como "cuándo se creó la opp".
 *  - `query` es búsqueda parcial sobre display_reference + contact
 *    (name/phone/email). PostgREST no permite `.or()` mezclando parent
 *    y embedded en un solo predicado, así que pre-resolvemos los
 *    `contact_id` que matchean el query y los inyectamos como `in.()`.
 *
 * Orden estable: `(last_modified_at DESC, id ASC)`.
 */
export async function listKanbanOpportunities(opts: {
  funnel: Funnel;
  stageId: UUID;
  assignedAdvisorId?: UUID | null;
  limit: number;
  offset?: number;
  dateFrom?: string;
  dateTo?: string;
  query?: string;
  /** Pre-resolved contact_ids that match the query — caller can pass
   *  this to avoid duplicate sub-queries when listing multiple stages
   *  with the same search. */
  matchingContactIds?: UUID[] | null;
}): Promise<KanbanOpportunity[]> {
  const { supabase, organizationId } = getTenantScopedClient();

  // Resuelve contact_ids para search si el caller no los pasó.
  let contactIds = opts.matchingContactIds;
  if (contactIds === undefined && opts.query && opts.query.trim().length > 0) {
    contactIds = await searchContactIdsForQuery(opts.query);
  }
  const hasQuery = !!opts.query && opts.query.trim().length > 0;
  const sanitized = hasQuery
    ? opts.query!.trim().replace(/[,.()*%\\]/g, " ").slice(0, 80)
    : "";

  let query = supabase
    .from("opportunities")
    .select(KANBAN_OPPORTUNITY_SELECT)
    .eq("organization_id", organizationId)
    .eq("funnel", opts.funnel)
    .eq("stage_id", opts.stageId)
    .is("cancelled_at", null);

  if (opts.assignedAdvisorId !== undefined) {
    if (opts.assignedAdvisorId === null) {
      query = query.is("assigned_advisor_id", null);
    } else {
      query = query.eq("assigned_advisor_id", opts.assignedAdvisorId);
    }
  }
  if (opts.dateFrom) query = query.gte("created_at", opts.dateFrom);
  if (opts.dateTo) query = query.lte("created_at", opts.dateTo);

  if (hasQuery) {
    const idsList = (contactIds ?? []).slice(0, 5000);
    if (idsList.length === 0 && sanitized.length === 0) {
      return [];
    }
    if (idsList.length === 0) {
      // Solo display_reference puede matchear.
      query = query.ilike("display_reference", `%${sanitized}%`);
    } else {
      const inList = idsList.join(",");
      // PostgREST `.or()` con `in.(...)` requiere el set entre paréntesis.
      query = query.or(
        `display_reference.ilike.%${sanitized}%,contact_id.in.(${inList})`,
      );
    }
  }

  query = query
    .order("last_modified_at", { ascending: false })
    .order("id", { ascending: true });

  const offset = opts.offset ?? 0;
  if (opts.limit > 0) query = query.range(offset, offset + opts.limit - 1);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as KanbanOpportunity[];
}

/**
 * Cuenta exacta de opps activas por etapa para un funnel. Misma
 * semántica que `listKanbanOpportunities`.
 *
 * Optimización (correcciones ronda 2): ya NO hace un `!inner` join
 * sobre contacts solo para contar. El search por contact se resuelve
 * pre-fetcheando los `contact_id` que matchean y filtrando con `in.()`.
 * Resultado: para una org con 10k opps, la query pasa de "trae 10k
 * rows con join + contar en JS" a "trae solo {id, stage_id}".
 */
export async function countKanbanOpportunitiesByStage(opts: {
  funnel: Funnel;
  assignedAdvisorId?: UUID | null;
  /** ISO date inclusive. Filtra por `created_at >= dateFrom`. */
  dateFrom?: string;
  /** ISO date inclusive. Filtra por `created_at <= dateTo`. */
  dateTo?: string;
  query?: string;
  /** Pre-resolved contact_ids — caller suele compartirlos con
   *  `listKanbanOpportunities` para evitar la sub-query repetida. */
  matchingContactIds?: UUID[] | null;
}): Promise<Record<UUID, number>> {
  const { supabase, organizationId } = getTenantScopedClient();

  let contactIds = opts.matchingContactIds;
  if (contactIds === undefined && opts.query && opts.query.trim().length > 0) {
    contactIds = await searchContactIdsForQuery(opts.query);
  }
  const hasQuery = !!opts.query && opts.query.trim().length > 0;
  const sanitized = hasQuery
    ? opts.query!.trim().replace(/[,.()*%\\]/g, " ").slice(0, 80)
    : "";

  let query = supabase
    .from("opportunities")
    .select("stage_id")
    .eq("organization_id", organizationId)
    .eq("funnel", opts.funnel)
    .is("cancelled_at", null);

  if (opts.assignedAdvisorId !== undefined) {
    if (opts.assignedAdvisorId === null) {
      query = query.is("assigned_advisor_id", null);
    } else {
      query = query.eq("assigned_advisor_id", opts.assignedAdvisorId);
    }
  }
  if (opts.dateFrom) query = query.gte("created_at", opts.dateFrom);
  if (opts.dateTo) query = query.lte("created_at", opts.dateTo);

  if (hasQuery) {
    const idsList = (contactIds ?? []).slice(0, 5000);
    if (idsList.length === 0 && sanitized.length === 0) {
      return {};
    }
    if (idsList.length === 0) {
      query = query.ilike("display_reference", `%${sanitized}%`);
    } else {
      const inList = idsList.join(",");
      query = query.or(
        `display_reference.ilike.%${sanitized}%,contact_id.in.(${inList})`,
      );
    }
  }

  // Cap explícito: el conteo no debería volcar millones de filas. 50k
  // es muy por encima de cualquier org realista en MVP — funciona como
  // circuit breaker si la query no quedó bien acotada.
  query = query.limit(50000);

  const { data, error } = await query;
  if (error) throw error;
  const counts: Record<UUID, number> = {};
  for (const row of (data ?? []) as Array<{ stage_id: UUID }>) {
    counts[row.stage_id] = (counts[row.stage_id] ?? 0) + 1;
  }
  return counts;
}

/**
 * Resuelve los `contact_id` que matchean un query parcial sobre
 * `full_name`, `phone` y `email`. Lote polish M6 ronda 2: lo extrae
 * del pipeline para que `.or()` aplique solo sobre la tabla principal
 * (PostgREST no soporta predicados mixtos parent+embedded en un solo
 * `.or()`).
 *
 * Cap: 5000 IDs — suficiente para una org del MVP. Si el query es
 * tan amplio que produce más, los excedentes no se pierden porque el
 * caller también filtra por `display_reference.ilike`; lo común es
 * que el query sea suficientemente específico para acotar mucho más.
 */
export async function searchContactIdsForQuery(rawQuery: string): Promise<UUID[]> {
  const sanitized = rawQuery
    .trim()
    .replace(/[,.()*%\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (sanitized.length === 0) return [];

  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .or(
      `full_name.ilike.%${sanitized}%,phone.ilike.%${sanitized}%,email.ilike.%${sanitized}%`,
    )
    .limit(5000);
  if (error) throw error;
  return (data ?? []).map((r) => (r as { id: UUID }).id);
}

/**
 * Resuelve una sola opp con contact embebido — útil para refrescar
 * una card específica tras un evento Realtime que solo trae el
 * payload de la fila `opportunities` (sin join de contact).
 */
export async function getKanbanOpportunityById(
  id: UUID,
): Promise<KanbanOpportunity | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select(KANBAN_OPPORTUNITY_SELECT)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as unknown as KanbanOpportunity | null;
}

/**
 * Marca una oportunidad como cancelada sin transición de etapa.
 * NO crea entrada en `opportunity_stage_history` — la cancelación
 * es un side-flag, no un cambio de etapa.
 *
 * Idempotente: si la opp ya está cancelada, retorna la fila sin
 * sobrescribir `cancelled_at` (preserva el primer timestamp).
 */
export async function cancelOpportunity(input: {
  opportunityId: UUID;
  source: string;
  note?: string | null;
  cancelledAt?: string;
}): Promise<{ opportunity: OpportunityRow; alreadyCancelled: boolean }> {
  const existing = await getOpportunityById(input.opportunityId);
  if (!existing) {
    throw new Error(`cancelOpportunity: opp ${input.opportunityId} no encontrada`);
  }
  if (existing.cancelled_at) {
    return { opportunity: existing, alreadyCancelled: true };
  }
  const ts = input.cancelledAt ?? new Date().toISOString();
  const updated = await updateOpportunity(input.opportunityId, {
    cancelled_at: ts,
    cancellation_source: input.source,
    cancellation_note: input.note ?? null,
    last_modified_at: ts,
    last_modified_source: input.source.startsWith("shopify") ? "shopify" : "platform",
  });
  return { opportunity: updated, alreadyCancelled: false };
}

// ============================================================
// opportunity_line_items
// ============================================================

export async function listLineItems(opportunityId: UUID): Promise<OpportunityLineItemRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunity_line_items")
    .select("*")
    .eq("opportunity_id", opportunityId)
    .eq("organization_id", organizationId);
  if (error) throw error;
  return data ?? [];
}

export async function replaceLineItems(
  opportunityId: UUID,
  items: Array<Omit<OppLineInsert, "organization_id" | "opportunity_id">>,
): Promise<OpportunityLineItemRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();

  // borra todo lo previo (M3 reemplaza en bloque cada vez que cambia la Draft Order)
  const { error: delError } = await supabase
    .from("opportunity_line_items")
    .delete()
    .eq("opportunity_id", opportunityId)
    .eq("organization_id", organizationId);
  if (delError) throw delError;

  if (items.length === 0) return [];

  const toInsert = items.map((it) => ({
    ...it,
    organization_id: organizationId,
    opportunity_id: opportunityId,
  }));
  const { data, error } = await supabase
    .from("opportunity_line_items")
    .insert(toInsert)
    .select("*");
  if (error) throw error;
  return data ?? [];
}

// ============================================================
// opportunity_stage_history (inmutable — solo insert + read)
// ============================================================

export async function recordStageChange(input: {
  opportunityId: UUID;
  fromStageId: UUID | null;
  toStageId: UUID;
  changedByUserId: UUID | null;
  context: StageHistoryContext;
  /**
   * Fecha real del evento de Shopify detrás de esta entrada (migración
   * 0025). Solo se pasa en contextos de origen Shopify — p.ej. la
   * entrada a "Cotización" generada por `draft_orders/*` recibe el
   * `created_at` del Draft Order. Las entradas de origen plataforma
   * (manual) la omiten: queda NULL y el dashboard cae a `changed_at`,
   * que ES la fecha real de la acción del usuario.
   */
  shopifyEventAt?: string | null;
}): Promise<OpportunityStageHistoryRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunity_stage_history")
    .insert({
      organization_id: organizationId,
      opportunity_id: input.opportunityId,
      from_stage_id: input.fromStageId,
      to_stage_id: input.toStageId,
      changed_by_user_id: input.changedByUserId,
      context: input.context,
      shopify_event_at: input.shopifyEventAt ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

// ============================================================
// Correctivo de fechas (migración 0025) — helpers de enumeración
// y re-fecha. Reusados por scripts/maintenance/backfill-opportunity-
// shopify-dates.ts. Idempotentes por construcción (filtran lo NO
// poblado todavía).
// ============================================================

/** Opp de Venta con Draft Order ligada pero sin `shopify_created_at`. */
export interface OppMissingShopifyCreatedAt {
  id: UUID;
  shopify_draft_order_id: string;
  created_at: string;
}

/**
 * Opps de Venta provenientes de un Draft Order (shopify_draft_order_id
 * no nulo) que aún no tienen poblado `shopify_created_at`. El correctivo
 * les trae la fecha real desde Shopify (GET draft_orders + mapper).
 */
export async function listVentaOppsMissingShopifyCreatedAt(): Promise<
  OppMissingShopifyCreatedAt[]
> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("id, shopify_draft_order_id, created_at")
    .eq("organization_id", organizationId)
    .eq("funnel", "venta")
    .not("shopify_draft_order_id", "is", null)
    .is("shopify_created_at", null)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as OppMissingShopifyCreatedAt[];
}

/** Opp ganada de Venta con pedido ligado — candidata a re-fecha de won_at. */
export interface WonOppForRedate {
  id: UUID;
  shopify_order_id: string;
  won_at: string;
  created_at: string;
}

/**
 * Opps de Venta GANADAS (won_at no nulo) con pedido ligado
 * (shopify_order_id no nulo). El correctivo re-fecha `won_at` a la fecha
 * real del pedido (`orders.shopify_created_at`) cuando difiere. Las
 * ganadas manuales sin pedido NO entran aquí: su won_at es la fecha real
 * de la acción de plataforma.
 */
export async function listWonVentaOppsWithOrder(): Promise<WonOppForRedate[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("id, shopify_order_id, won_at, created_at")
    .eq("organization_id", organizationId)
    .eq("funnel", "venta")
    .not("won_at", "is", null)
    .not("shopify_order_id", "is", null)
    .order("won_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as WonOppForRedate[];
}

/**
 * Puebla `shopify_event_at` en las entradas de historial de UN contexto
 * de UNA opp que todavía lo tengan NULL (la guarda de inmutabilidad de
 * 0025 permite escribir SOLO esa columna). Devuelve cuántas filas tocó.
 * Idempotente: el filtro `shopify_event_at IS NULL` evita re-escribir.
 */
export async function setStageHistoryShopifyEventAt(input: {
  opportunityId: UUID;
  context: StageHistoryContext;
  shopifyEventAt: string;
}): Promise<number> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunity_stage_history")
    .update({ shopify_event_at: input.shopifyEventAt })
    .eq("organization_id", organizationId)
    .eq("opportunity_id", input.opportunityId)
    .eq("context", input.context)
    .is("shopify_event_at", null)
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

export async function listStageHistory(
  opportunityId: UUID,
): Promise<OpportunityStageHistoryRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunity_stage_history")
    .select("*")
    .eq("opportunity_id", opportunityId)
    .eq("organization_id", organizationId)
    .order("changed_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}
