import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import type {
  Funnel,
  LossReasonRow,
  PipelineStageRow,
  Database,
  UUID,
} from "@/lib/types/database";

type StageInsert = Database["public"]["Tables"]["pipeline_stages"]["Insert"];
type StageUpdate = Database["public"]["Tables"]["pipeline_stages"]["Update"];
type LossInsert = Database["public"]["Tables"]["loss_reasons"]["Insert"];
type LossUpdate = Database["public"]["Tables"]["loss_reasons"]["Update"];

// ============================================================
// pipeline_stages
// ============================================================

export async function listPipelineStages(funnel?: Funnel): Promise<PipelineStageRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("pipeline_stages")
    .select("*")
    .eq("organization_id", organizationId)
    .order("position", { ascending: true });
  if (funnel) query = query.eq("funnel", funnel);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function getStageById(id: UUID): Promise<PipelineStageRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("pipeline_stages")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function getInitialStage(funnel: Funnel): Promise<PipelineStageRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("pipeline_stages")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("funnel", funnel)
    .eq("is_initial", true)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function createStage(
  input: Omit<StageInsert, "organization_id">,
): Promise<PipelineStageRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("pipeline_stages")
    .insert({ ...input, organization_id: organizationId })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function updateStage(
  id: UUID,
  patch: StageUpdate,
): Promise<PipelineStageRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("pipeline_stages")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function deleteStage(id: UUID): Promise<void> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { error } = await supabase
    .from("pipeline_stages")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (error) throw error;
}

/**
 * Cuenta TODAS las oportunidades (incluidas canceladas) que
 * referencian una etapa. Usado por el bloqueo de eliminación: el FK
 * `opportunities.stage_id ... on delete restrict` impide borrar la
 * etapa si existe cualquier opp apuntándola, sin importar su estado
 * de cancelación — por eso el conteo no filtra `cancelled_at`.
 */
export async function countOpportunitiesForStage(stageId: UUID): Promise<number> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { count, error } = await supabase
    .from("opportunities")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("stage_id", stageId);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Cuenta las filas de `opportunity_stage_history` que APUNTAN a una
 * etapa como destino (`to_stage_id`). Ese FK es `on delete restrict` y
 * la tabla es inmutable (append-only, sin purga), así que cualquier
 * etapa por la que ALGUNA vez pasó una oportunidad no se puede borrar
 * en duro — aunque hoy no tenga oportunidades vivas dentro. Cuando el
 * conteo es > 0 la etapa se DESACTIVA en vez de borrarse (preserva la
 * trazabilidad). `from_stage_id` es `on delete set null`, no bloquea,
 * por eso NO se cuenta aquí.
 */
export async function countStageHistoryReferences(stageId: UUID): Promise<number> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { count, error } = await supabase
    .from("opportunity_stage_history")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("to_stage_id", stageId);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Reordena las etapas de un funnel aplicando posiciones 1..N en el
 * orden recibido. Persiste cada UPDATE de forma individual (no hay
 * unique constraint sobre `position`, así que no hay riesgo de
 * colisión transitoria). Valida que cada id pertenezca al funnel/org.
 */
export async function reorderStages(
  funnel: Funnel,
  orderedIds: UUID[],
): Promise<void> {
  const { supabase, organizationId } = getTenantScopedClient();
  const current = await listPipelineStages(funnel);
  const validIds = new Set(current.map((s) => s.id));
  for (const id of orderedIds) {
    if (!validIds.has(id)) {
      throw new Error(
        `reorderStages: etapa ${id} no pertenece al funnel ${funnel} de la organización`,
      );
    }
  }
  for (let i = 0; i < orderedIds.length; i++) {
    const { error } = await supabase
      .from("pipeline_stages")
      .update({ position: i + 1 })
      .eq("id", orderedIds[i])
      .eq("organization_id", organizationId);
    if (error) throw error;
  }
}

// ============================================================
// loss_reasons
// ============================================================

export async function listLossReasons(opts: { activeOnly?: boolean } = {}): Promise<LossReasonRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("loss_reasons")
    .select("*")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });
  if (opts.activeOnly) query = query.eq("is_active", true);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function createLossReason(
  input: Omit<LossInsert, "organization_id">,
): Promise<LossReasonRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("loss_reasons")
    .insert({ ...input, organization_id: organizationId })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function updateLossReason(
  id: UUID,
  patch: LossUpdate,
): Promise<LossReasonRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("loss_reasons")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function getLossReasonById(id: UUID): Promise<LossReasonRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("loss_reasons")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/**
 * Cuenta oportunidades que referencian un motivo de pérdida. El FK
 * `opportunities.loss_reason_id ... on delete restrict` bloquea el
 * borrado a nivel BD; este conteo da el mensaje amigable previo.
 */
export async function countOpportunitiesForLossReason(reasonId: UUID): Promise<number> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { count, error } = await supabase
    .from("opportunities")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("loss_reason_id", reasonId);
  if (error) throw error;
  return count ?? 0;
}

export async function deleteLossReason(id: UUID): Promise<void> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { error } = await supabase
    .from("loss_reasons")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (error) throw error;
}
