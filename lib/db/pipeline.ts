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
