import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import type {
  GoalRow,
  TagMappingRow,
  TagClassification,
  Database,
  UUID,
} from "@/lib/types/database";

type GoalInsert = Database["public"]["Tables"]["goals"]["Insert"];
type GoalUpdate = Database["public"]["Tables"]["goals"]["Update"];
type TagInsert = Database["public"]["Tables"]["tag_mappings"]["Insert"];
type TagUpdate = Database["public"]["Tables"]["tag_mappings"]["Update"];

// ============================================================
// goals
// ============================================================

export async function listGoals(opts: { userId?: UUID | null } = {}): Promise<GoalRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("goals")
    .select("*")
    .eq("organization_id", organizationId)
    .order("period_start", { ascending: false });
  if (opts.userId !== undefined) {
    if (opts.userId === null) query = query.is("user_id", null);
    else query = query.eq("user_id", opts.userId);
  }
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function createGoal(
  input: Omit<GoalInsert, "organization_id">,
): Promise<GoalRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("goals")
    .insert({ ...input, organization_id: organizationId })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function updateGoal(id: UUID, patch: GoalUpdate): Promise<GoalRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("goals")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function deleteGoal(id: UUID): Promise<void> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { error } = await supabase
    .from("goals")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (error) throw error;
}

// ============================================================
// tag_mappings
// ============================================================

export async function listTagMappings(opts: {
  classification?: TagClassification;
} = {}): Promise<TagMappingRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("tag_mappings")
    .select("*")
    .eq("organization_id", organizationId)
    .order("original_tag", { ascending: true });
  if (opts.classification) query = query.eq("classification", opts.classification);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function getTagMappingByNormalized(
  normalizedTag: string,
): Promise<TagMappingRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("tag_mappings")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("normalized_tag", normalizedTag)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function upsertTagMapping(
  input: Omit<TagInsert, "organization_id">,
): Promise<TagMappingRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("tag_mappings")
    .upsert(
      { ...input, organization_id: organizationId },
      { onConflict: "organization_id,normalized_tag" },
    )
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function updateTagMapping(
  id: UUID,
  patch: TagUpdate,
): Promise<TagMappingRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("tag_mappings")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/**
 * Elimina un mapping de tag por su `normalized_tag` (citext único por
 * org). Usado por la limpieza manual de tags huérfanas (M7.2 fix #5):
 * el caller DEBE verificar antes que 0 entidades la lleven. Devuelve
 * cuántas filas se borraron (0 si no existía).
 */
export async function deleteTagMappingByNormalized(
  normalizedTag: string,
): Promise<number> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("tag_mappings")
    .delete()
    .eq("organization_id", organizationId)
    .eq("normalized_tag", normalizedTag)
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}
