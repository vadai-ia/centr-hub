import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import type {
  TagMappingRow,
  TagClassification,
  Database,
  UUID,
} from "@/lib/types/database";

// goals CRUD se movió a `lib/db/metas.ts` con el reshape de M2v2 (0031).

type TagInsert = Database["public"]["Tables"]["tag_mappings"]["Insert"];
type TagUpdate = Database["public"]["Tables"]["tag_mappings"]["Update"];

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
