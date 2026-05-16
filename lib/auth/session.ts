import "server-only";
import { cookies } from "next/headers";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Role, UUID } from "@/lib/types/database";

export const ACTIVE_ORG_COOKIE = "centr_active_org" as const;

export interface OrgWithRole {
  id: UUID;
  name: string;
  slug: string;
  role: Role;
  logoUrl: string | null;
}

export interface SessionData {
  userId: UUID;
  email: string;
  displayName: string | null;
  orgs: OrgWithRole[];
  activeOrg: OrgWithRole;
}

type SessionResult =
  | { status: "ok"; data: SessionData }
  | { status: "no_membership" }
  | { status: "no_auth" };

interface MembershipWithOrg {
  organization_id: UUID;
  role: Role;
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

  return {
    status: "ok",
    data: {
      userId: user.id as UUID,
      email: user.email ?? "",
      displayName: (user.user_metadata?.full_name as string | undefined) ?? null,
      orgs,
      activeOrg,
    },
  };
}
