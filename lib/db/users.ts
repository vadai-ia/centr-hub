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
 * Vendedores ELEGIBLES para el reparto round-robin de leads por webhook
 * (0045). Es `listActiveRealVendors` + el filtro `in_lead_rotation = true`.
 *
 * IMPORTANTE: úsala SOLO desde el round-robin (`pickRoundRobinAdvisor`). El
 * resto del sistema (selectores de asignación manual, mapeo de tags, etc.)
 * sigue usando `listActiveRealVendors` — el toggle NO debe restringir la
 * visibilidad/asignabilidad de un vendedor, solo su pertenencia a la rotación.
 */
export async function listRotationEligibleVendors(
  organizationId: UUID,
): Promise<Array<MembershipRow & { profile: UserProfileRow }>> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("*, profile:user_profiles!inner(*)")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .eq("role", "vendedor")
    .eq("in_lead_rotation", true)
    .eq("profile.is_system_user", false)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Array<MembershipRow & { profile: UserProfileRow }>;
}

/**
 * Resuelve el membership (vendedor activo) mapeado a un `whaapy_agent_id`.
 * Inverso de `resolveWhaapyAgentIdForMembership` — usado por el inbound de
 * Whaapy para asignar el asesor de un contacto nuevo desde su agente. Devuelve
 * el `membership.id` o null si el agente no está mapeado a ningún vendedor
 * activo. Ver CLAUDE.md "Sincronización agente↔Whaapy".
 */
export async function findActiveMembershipIdByWhaapyAgentId(
  organizationId: UUID,
  whaapyAgentId: string,
): Promise<UUID | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("whaapy_agent_id", whaapyAgentId)
    .eq("is_active", true)
    .eq("role", "vendedor")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data?.id as UUID | undefined) ?? null;
}

/** Setea el flag de pertenencia a la rotación de un membership (admin, 0045). */
export async function setMembershipInLeadRotation(
  membershipId: UUID,
  inRotation: boolean,
): Promise<MembershipRow> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("memberships")
    .update({ in_lead_rotation: inRotation })
    .eq("id", membershipId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/**
 * Lista vendedores REALES para el mapeo de tags (M7.2, Bloque 5).
 * A diferencia de `listActiveRealVendors`, INCLUYE vendedores
 * desactivados (no filtra por `is_active`) — un mapeo histórico a un
 * vendedor que ya no opera sigue siendo válido para atribución. R10:
 * el usuario sistema "Histórico" SIEMPRE se excluye (`is_system_user`).
 */
export async function listRealVendorsForMapping(
  organizationId: UUID,
): Promise<Array<MembershipRow & { profile: UserProfileRow }>> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("*, profile:user_profiles!inner(*)")
    .eq("organization_id", organizationId)
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

// ============================================================
// Gestión de usuarios (M9.2)
// ============================================================

/**
 * Lista los memberships GESTIONABLES de la org: todos excepto el
 * usuario sistema "Histórico" (`is_system_user=true`, R10). Incluye
 * activos e inactivos, admins y vendedores. Trae el perfil embebido.
 */
export async function listManageableMemberships(
  organizationId: UUID,
): Promise<Array<MembershipRow & { profile: UserProfileRow }>> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("*, profile:user_profiles!inner(*)")
    .eq("organization_id", organizationId)
    .eq("profile.is_system_user", false)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Array<MembershipRow & { profile: UserProfileRow }>;
}

export async function updateMembershipRole(
  membershipId: UUID,
  role: string,
): Promise<MembershipRow> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("memberships")
    .update({ role })
    .eq("id", membershipId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/**
 * Mapea (o des-mapea con `null`) el agente Whaapy de un vendedor
 * (`memberships.whaapy_agent_id`, columna de 0002). Es el eslabón que faltaba
 * poblar: sin él, la asignación inbound (`conversation.assigned`) se descarta
 * y el `assigned_agent_id` outbound se omite (Track 2 / Bloque C). Filtra por
 * org como defensa multi-tenant (el caller ya validó que el membership es un
 * vendedor real de la org).
 */
export async function updateMembershipWhaapyAgentId(
  organizationId: UUID,
  membershipId: UUID,
  whaapyAgentId: string | null,
): Promise<MembershipRow> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("memberships")
    .update({ whaapy_agent_id: whaapyAgentId })
    .eq("id", membershipId)
    .eq("organization_id", organizationId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export interface AuthUserInfo {
  email: string | null;
  lastSignInAt: string | null;
  emailConfirmedAt: string | null;
  /** true cuando GoTrue no pudo cargar la fila (placeholder SQL crudo). */
  loadError: boolean;
}

/**
 * Info de auth de un usuario, resuelta por `getUserById` (targetado).
 * El path bulk `listUsers()` falla con "Database error finding users"
 * en este entorno; por fila funciona salvo para las filas insertadas
 * por SQL crudo (Histórico, Gina/Pepe pre-vínculo), que devuelven
 * "Database error loading user" → `loadError=true`.
 */
export async function getAuthUserInfo(userId: UUID): Promise<AuthUserInfo> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data?.user) {
    return {
      email: null,
      lastSignInAt: null,
      emailConfirmedAt: null,
      loadError: true,
    };
  }
  const u = data.user;
  return {
    email: u.email ?? null,
    lastSignInAt: u.last_sign_in_at ?? null,
    emailConfirmedAt:
      (u as { email_confirmed_at?: string | null }).email_confirmed_at ?? null,
    loadError: false,
  };
}

// ---- Auth admin (M9.2, Block 2) — invitaciones y vínculo de login ----

/**
 * Repara una fila auth.users insertada por SQL crudo (tokens NULL) para
 * que GoTrue pueda cargarla. Invoca el RPC de la migración 0028. Es
 * idempotente y no toca el `id`. Si el RPC no existe (migración no
 * aplicada), lanza — el caller lo traduce a mensaje accionable.
 */
export async function repairAuthUserTokens(userId: UUID): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.rpc("repair_auth_user_tokens", {
    p_user_id: userId,
  });
  if (error) throw error;
}

/** Fija el email (confirmado) y opcionalmente el nombre en una fila auth existente. */
export async function setAuthUserEmail(
  userId: UUID,
  email: string,
  fullName?: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.auth.admin.updateUserById(userId, {
    email,
    email_confirm: true,
    ...(fullName ? { user_metadata: { full_name: fullName } } : {}),
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

/** Invita un usuario NUEVO por email (Supabase built-in). Devuelve su id. */
export async function inviteAuthUser(
  email: string,
  fullName: string,
  redirectTo: string,
): Promise<{ ok: true; userId: UUID } | { ok: false; message: string }> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
    redirectTo,
  });
  if (error || !data?.user) {
    return { ok: false, message: error?.message ?? "No se pudo invitar." };
  }
  return { ok: true, userId: data.user.id as UUID };
}

/** Envía el email built-in de recuperación (definir contraseña) a un usuario existente. */
export async function sendSetPasswordEmail(
  email: string,
  redirectTo: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo,
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

/** Borra una fila de auth.users (compensación si falla crear perfil/membership tras invitar). */
export async function deleteAuthUser(userId: UUID): Promise<void> {
  const supabase = getSupabaseAdminClient();
  await supabase.auth.admin.deleteUser(userId);
}

/**
 * Cuenta oportunidades ACTIVAS (no terminales, no canceladas) por
 * membership de la org. "Activa" = `cancelled_at IS NULL AND won_at IS
 * NULL AND lost_at IS NULL` (alineado con el diagnóstico Block 0 y con
 * la semántica de "pendientes" que bloquea la desactivación — Block 3).
 * Devuelve un Map membershipId → conteo.
 */
export async function countActiveOpportunitiesByAdvisor(
  organizationId: UUID,
): Promise<Map<UUID, number>> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("assigned_advisor_id")
    .eq("organization_id", organizationId)
    .is("cancelled_at", null)
    .is("won_at", null)
    .is("lost_at", null)
    .not("assigned_advisor_id", "is", null);
  if (error) throw error;
  const out = new Map<UUID, number>();
  for (const row of (data ?? []) as Array<{ assigned_advisor_id: UUID }>) {
    out.set(row.assigned_advisor_id, (out.get(row.assigned_advisor_id) ?? 0) + 1);
  }
  return out;
}
