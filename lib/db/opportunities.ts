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
 * Filtros adicionales (lote de polish M6):
 *  - `dateFrom`/`dateTo` filtran por `last_modified_at` (rango inclusivo).
 *  - `query` es búsqueda parcial sobre display_reference, contact name,
 *    contact phone y contact email (case-insensitive).
 *
 * Orden estable: `(last_modified_at DESC, id ASC)` para que la
 * paginación por offset sea determinista incluso ante ties de
 * timestamp (raro pero posible con auto-creación C2 en bulk).
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
}): Promise<KanbanOpportunity[]> {
  const { supabase, organizationId } = getTenantScopedClient();
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
  if (opts.dateFrom) query = query.gte("last_modified_at", opts.dateFrom);
  if (opts.dateTo) query = query.lte("last_modified_at", opts.dateTo);
  if (opts.query && opts.query.trim().length > 0) {
    const sanitized = opts.query.trim().replace(/[,.()*%\\]/g, " ").slice(0, 80);
    if (sanitized.length > 0) {
      query = query.or(
        `display_reference.ilike.%${sanitized}%,contact.full_name.ilike.%${sanitized}%,contact.phone.ilike.%${sanitized}%,contact.email.ilike.%${sanitized}%`,
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
 * semántica que `listKanbanOpportunities` (filtros opcionales)
 * pero retorna sólo conteos — usado por el kanban para mostrar el
 * número real en cada columna (no "50+").
 */
export async function countKanbanOpportunitiesByStage(opts: {
  funnel: Funnel;
  assignedAdvisorId?: UUID | null;
  /** ISO date inclusive. Filtra por last_modified_at >= dateFrom. */
  dateFrom?: string;
  /** ISO date inclusive. Filtra por last_modified_at <= dateTo. */
  dateTo?: string;
  /** Texto libre — buscar en display_reference y contact name/phone. */
  query?: string;
}): Promise<Record<UUID, number>> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("opportunities")
    .select("stage_id, contact:contacts!inner(full_name, phone, email)", { count: "exact" })
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
  if (opts.dateFrom) query = query.gte("last_modified_at", opts.dateFrom);
  if (opts.dateTo) query = query.lte("last_modified_at", opts.dateTo);
  if (opts.query && opts.query.trim().length > 0) {
    const sanitized = opts.query.trim().replace(/[,.()*%\\]/g, " ").slice(0, 80);
    if (sanitized.length > 0) {
      query = query.or(
        `display_reference.ilike.%${sanitized}%,contact.full_name.ilike.%${sanitized}%,contact.phone.ilike.%${sanitized}%,contact.email.ilike.%${sanitized}%`,
      );
    }
  }

  const { data, error } = await query;
  if (error) throw error;
  const counts: Record<UUID, number> = {};
  for (const row of (data ?? []) as Array<{ stage_id: UUID }>) {
    counts[row.stage_id] = (counts[row.stage_id] ?? 0) + 1;
  }
  return counts;
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
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
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
