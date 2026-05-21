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
