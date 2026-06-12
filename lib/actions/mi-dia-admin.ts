"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenantContext } from "@/lib/tenant/context";
import { resolveAdminContext } from "@/lib/auth/admin-guard";
import { getMembershipUserId } from "@/lib/db/operational";
import { reassignOpportunityAdvisor } from "@/lib/services/opportunity-reassignment";
import {
  loadMiDiaAdminExtras,
  type MiDiaAdminExtras,
} from "@/lib/services/mi-dia-admin";
import { loadMiDiaForUser, type MiDiaData } from "@/lib/services/mi-dia";

/**
 * Server actions de Mi Día del admin (M1v2, Bloque C). Todas exigen
 * rol admin/superadmin. La asignación desde aquí reusa el núcleo
 * `reassignOpportunityAdvisor` (marcado como manual → la reconciliación
 * horaria y los hooks de atribución NO la pisan).
 */

export type MiDiaAdminExtrasResult =
  | { ok: true; extras: MiDiaAdminExtras }
  | { ok: false; message: string };

export async function loadMiDiaAdminExtrasAction(): Promise<MiDiaAdminExtrasResult> {
  const admin = await resolveAdminContext();
  if (!admin.ok) return admin;
  return withTenantContext(
    admin.ctx.orgId,
    async () => ({ ok: true as const, extras: await loadMiDiaAdminExtras() }),
    { source: "user_session" },
  );
}

const memberSchema = z.object({ membershipId: z.string().uuid() });

export type MiDiaMemberResult =
  | { ok: true; data: MiDiaData; membershipId: string }
  | { ok: false; message: string };

export async function loadMiDiaMemberAction(raw: unknown): Promise<MiDiaMemberResult> {
  const parsed = memberSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Parámetros inválidos." };
  const admin = await resolveAdminContext();
  if (!admin.ok) return admin;
  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const userId = await getMembershipUserId(parsed.data.membershipId);
      if (!userId) return { ok: false as const, message: "El vendedor no existe." };
      const data = await loadMiDiaForUser({
        userId,
        advisorMembershipId: parsed.data.membershipId,
      });
      return { ok: true as const, data, membershipId: parsed.data.membershipId };
    },
    { source: "user_session" },
  );
}

const assignSchema = z.object({
  opportunityId: z.string().uuid(),
  membershipId: z.string().uuid(),
});

export type MiDiaAssignResult = { ok: true } | { ok: false; message: string };

export async function assignOpportunityAction(raw: unknown): Promise<MiDiaAssignResult> {
  const parsed = assignSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Parámetros inválidos." };
  const admin = await resolveAdminContext();
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const res = await reassignOpportunityAdvisor({
        opportunityId: parsed.data.opportunityId,
        newMembershipId: parsed.data.membershipId,
        actorUserId: admin.ctx.userId,
      });
      if (!res.ok) return { ok: false as const, message: res.message };
      revalidatePath("/mi-dia");
      return { ok: true as const };
    },
    { source: "user_session" },
  );
}
