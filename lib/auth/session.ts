import "server-only";
import { cookies } from "next/headers";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getRoleByKey } from "@/lib/db/roles";
import {
  fallbackCapabilities,
  type RoleCapabilities,
} from "@/lib/auth/capabilities";
import type { UUID } from "@/lib/types/database";

export const ACTIVE_ORG_COOKIE = "centr_active_org" as const;

export interface OrgWithRole {
  id: UUID;
  name: string;
  slug: string;
  /** `memberships.role` — la key del rol (sistema o custom). */
  role: string;
  logoUrl: string | null;
}

export interface SessionData {
  userId: UUID;
  email: string;
  displayName: string | null;
  orgs: OrgWithRole[];
  activeOrg: OrgWithRole;
  /**
   * Capacidades resueltas del rol en la org ACTIVA (0039). Es la fuente de
   * verdad de permisos: `canSeeAllData(activeRole)` reemplaza al viejo
   * `isAdmin` para alcance de datos, y `hasTab(activeRole, key)` gatea
   * pestañas/rutas/acciones. Se resuelve desde la tabla `roles`; si por
   * algún motivo no hay fila (no debería), cae a `fallbackCapabilities`.
   */
  activeRole: RoleCapabilities;
}

type SessionResult =
  | { status: "ok"; data: SessionData }
  | { status: "no_membership" }
  | { status: "no_auth" };

interface MembershipWithOrg {
  organization_id: UUID;
  role: string;
  is_active: boolean;
  organization: {
    id: UUID;
    name: string;
    slug: string;
  };
}

export async function getSession(): Promise<SessionResult> {
  const serverClient = getSupabaseServerClient();
  const {
    data: { user },
  } = await serverClient.auth.getUser();

  if (!user) return { status: "no_auth" };

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("memberships")
    .select("organization_id, role, is_active, organization:organizations(id, name, slug)")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .order("created_at", { ascending: true });

  if (error || !data || data.length === 0) {
    return { status: "no_membership" };
  }

  const memberships = data as unknown as MembershipWithOrg[];

  const orgs: OrgWithRole[] = memberships.map((m) => ({
    id: m.organization_id,
    name: m.organization.name,
    slug: m.organization.slug,
    role: m.role,
    logoUrl: null,
  }));

  const cookieStore = cookies();
  const savedOrgId = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;
  const activeOrg = orgs.find((o) => o.id === savedOrgId) ?? orgs[0];

  const activeRole = await resolveRoleCapabilities(activeOrg.id, activeOrg.role);

  return {
    status: "ok",
    data: {
      userId: user.id as UUID,
      email: user.email ?? "",
      displayName: (user.user_metadata?.full_name as string | undefined) ?? null,
      orgs,
      activeOrg,
      activeRole,
    },
  };
}

/**
 * Resuelve las capacidades del rol activo desde la tabla `roles`. Fallback
 * defensivo si no hay fila (no debería: 0039 siembra los de sistema y el FK
 * garantiza que exista) o si la lectura falla — nunca deja la sesión rota.
 */
async function resolveRoleCapabilities(
  orgId: UUID,
  roleKey: string,
): Promise<RoleCapabilities> {
  try {
    const row = await getRoleByKey(orgId, roleKey);
    if (!row) return fallbackCapabilities(roleKey);
    return {
      key: row.key,
      label: row.label,
      dataScope: row.data_scope,
      allowedTabs: row.allowed_tabs,
      isSystem: row.is_system,
    };
  } catch {
    return fallbackCapabilities(roleKey);
  }
}
