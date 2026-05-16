import "server-only";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type {
  MembershipRow,
  UserProfileRow,
  UUID,
  Role,
  Database,
} from "@/lib/types/database";

type ProfileInsert = Database["public"]["Tables"]["user_profiles"]["Insert"];
type ProfileUpdate = Database["public"]["Tables"]["user_profiles"]["Update"];
type MembershipInsert = Database["public"]["Tables"]["memberships"]["Insert"];

export async function getUserProfile(
  id: UUID,
): Promise<UserProfileRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function createUserProfile(
  input: ProfileInsert,
): Promise<UserProfileRow> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_profiles")
    .insert(input)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function updateUserProfile(
  id: UUID,
  patch: ProfileUpdate,
): Promise<UserProfileRow> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("user_profiles")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function listMembershipsForUser(
  userId: UUID,
): Promise<MembershipRow[]> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function listMembershipsForOrganization(
  organizationId: UUID,
): Promise<MembershipRow[]> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function createMembership(
  input: MembershipInsert,
): Promise<MembershipRow> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("memberships")
    .insert(input)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function setMembershipActive(
  membershipId: UUID,
  isActive: boolean,
): Promise<MembershipRow> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("memberships")
    .update({ is_active: isActive })
    .eq("id", membershipId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function getMembership(
  userId: UUID,
  organizationId: UUID,
): Promise<MembershipRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("*")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/**
 * Lista vendedores REALES (no system users + activos) de la
 * organización. R10: el usuario sistema "Histórico" se excluye
 * de dropdowns de asignación manual.
 */
export async function listActiveRealVendors(
  organizationId: UUID,
): Promise<Array<MembershipRow & { profile: UserProfileRow }>> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("*, profile:user_profiles!inner(*)")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .eq("role", "vendedor")
    .eq("profile.is_system_user", false)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Array<MembershipRow & { profile: UserProfileRow }>;
}

/**
 * Devuelve la membresía del usuario sistema "Histórico" de la org.
 * Único caller legítimo: backfill de M11.
 */
export async function getHistoricMembership(
  organizationId: UUID,
): Promise<MembershipRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("*, profile:user_profiles!inner(id, is_system_user)")
    .eq("organization_id", organizationId)
    .eq("profile.is_system_user", true)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  // strip joined profile before returning
  const { profile: _profile, ...row } = data as MembershipRow & {
    profile: Pick<UserProfileRow, "id" | "is_system_user">;
  };
  void _profile;
  return row;
}

export function makeRole(role: Role): Role {
  // tiny helper to keep callsites readable
  return role;
}
