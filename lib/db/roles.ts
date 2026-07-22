import "server-only";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { RoleRow, UUID } from "@/lib/types/database";

/**
 * Data layer de roles configurables (0039). Todas las lecturas/escrituras
 * usan el cliente admin (service_role) — la autorización vive en la capa de
 * actions (admin del panel de Roles). El aislamiento por org es explícito
 * (`.eq("organization_id", ...)`) además del RLS de la tabla.
 */

export async function listRoles(organizationId: UUID): Promise<RoleRow[]> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("roles")
    .select("*")
    .eq("organization_id", organizationId)
    .order("is_system", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as RoleRow[];
}

export async function getRoleByKey(
  organizationId: UUID,
  key: string,
): Promise<RoleRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("roles")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  return (data as RoleRow | null) ?? null;
}

export async function getRoleById(
  organizationId: UUID,
  id: UUID,
): Promise<RoleRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("roles")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as RoleRow | null) ?? null;
}

export interface CreateRoleInput {
  organizationId: UUID;
  key: string;
  label: string;
  dataScope: "own" | "all";
  allowedTabs: string[];
}

export async function insertRole(input: CreateRoleInput): Promise<RoleRow> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("roles")
    .insert({
      organization_id: input.organizationId,
      key: input.key,
      label: input.label,
      data_scope: input.dataScope,
      allowed_tabs: input.allowedTabs,
      is_system: false,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as RoleRow;
}

export interface UpdateRolePatch {
  label?: string;
  dataScope?: "own" | "all";
  allowedTabs?: string[];
}

export async function updateRoleRow(
  organizationId: UUID,
  id: UUID,
  patch: UpdateRolePatch,
): Promise<RoleRow> {
  const supabase = getSupabaseAdminClient();
  const dbPatch: Record<string, unknown> = {};
  if (patch.label !== undefined) dbPatch.label = patch.label;
  if (patch.dataScope !== undefined) dbPatch.data_scope = patch.dataScope;
  if (patch.allowedTabs !== undefined) dbPatch.allowed_tabs = patch.allowedTabs;
  const { data, error } = await supabase
    .from("roles")
    .update(dbPatch)
    .eq("organization_id", organizationId)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data as RoleRow;
}

export async function deleteRoleRow(
  organizationId: UUID,
  id: UUID,
): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("roles")
    .delete()
    .eq("organization_id", organizationId)
    .eq("id", id);
  if (error) throw error;
}

/**
 * Cuenta memberships REALES (activos + inactivos) que usan una role key.
 * Excluye al usuario sistema "Histórico" (`is_system_user=true`, R10) para
 * cuadrar con la lista de Usuarios (`listManageableMemberships`, que también
 * lo oculta) — si no, el rol 'vendedor' del Histórico inflaba el contador en
 * +1. Alimenta el contador del constructor de roles y el guardrail de borrado
 * (un rol que solo tuviera al Histórico sí debe poder borrarse).
 */
export async function countMembershipsWithRoleKey(
  organizationId: UUID,
  roleKey: string,
): Promise<number> {
  const supabase = getSupabaseAdminClient();
  const { count, error } = await supabase
    .from("memberships")
    .select("id, profile:user_profiles!inner(is_system_user)", {
      count: "exact",
      head: true,
    })
    .eq("organization_id", organizationId)
    .eq("role", roleKey)
    .eq("profile.is_system_user", false);
  if (error) throw error;
  return count ?? 0;
}
