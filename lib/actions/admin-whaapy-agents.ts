"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenantContext } from "@/lib/tenant/context";
import { resolveAdminContext } from "@/lib/auth/admin-guard";
import {
  listRealVendorsForMapping,
  updateMembershipWhaapyAgentId,
} from "@/lib/db/users";
import { recordAuditEvent } from "@/lib/db/operational";
import { listWhaapyTeam, type WhaapyAgent } from "@/lib/whaapy/team";
import { WhaapyApiError } from "@/lib/whaapy/admin-client";
import type { Json } from "@/lib/types/database";

/**
 * Server actions del mapeo asesor ↔ agente Whaapy (Track 2 / Bloque C). SOLO
 * admin/superadmin. Escribe `memberships.whaapy_agent_id` — el eslabón que
 * habilita la asignación bidireccional con el Whaapy de Venta. Incluye la
 * lista de vendedores (con su mapeo actual) y el equipo traído de Whaapy; si
 * el fetch del equipo falla, la UI permite capturar el id manualmente.
 */

export interface AdvisorMappingRow {
  membershipId: string;
  name: string;
  active: boolean;
  whaapyAgentId: string | null;
}

export type WhaapyAgentMappingLoadResult =
  | { ok: true; advisors: AdvisorMappingRow[]; team: WhaapyAgent[] | null; teamError: string | null }
  | { ok: false; message: string };

export type WhaapyAgentMappingSetResult =
  | { ok: true; advisors: AdvisorMappingRow[] }
  | { ok: false; message: string };

function friendlyTeamError(err: unknown): string {
  if (err instanceof WhaapyApiError) {
    return `No se pudo cargar el equipo de Whaapy (HTTP ${err.status}). Puedes capturar el ID del agente manualmente.`;
  }
  return "No se pudo cargar el equipo de Whaapy. Puedes capturar el ID del agente manualmente.";
}

async function loadAdvisors(orgId: string): Promise<AdvisorMappingRow[]> {
  const vendors = await listRealVendorsForMapping(orgId);
  return vendors.map((v) => ({
    membershipId: v.id,
    name: v.profile.full_name ?? "Vendedor",
    active: v.is_active,
    whaapyAgentId: v.whaapy_agent_id ?? null,
  }));
}

export async function loadWhaapyAgentMapping(): Promise<WhaapyAgentMappingLoadResult> {
  const admin = await resolveAdminContext("admin-agentes-whaapy");
  if (!admin.ok) return admin;
  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const advisors = await loadAdvisors(admin.ctx.orgId);
      let team: WhaapyAgent[] | null = null;
      let teamError: string | null = null;
      try {
        team = await listWhaapyTeam({ organizationId: admin.ctx.orgId });
      } catch (err) {
        teamError = friendlyTeamError(err);
      }
      return { ok: true as const, advisors, team, teamError };
    },
    { source: "user_session" },
  );
}

const setSchema = z.object({
  membershipId: z.string().uuid(),
  // null / "" → des-mapear. Un id concreto → mapear.
  whaapyAgentId: z.string().trim().min(1).max(200).nullable().optional(),
});

export async function setWhaapyAgentIdAction(
  raw: unknown,
): Promise<WhaapyAgentMappingSetResult> {
  const parsed = setSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos inválidos." };
  const admin = await resolveAdminContext("admin-agentes-whaapy");
  if (!admin.ok) return admin;

  const whaapyAgentId = parsed.data.whaapyAgentId ?? null;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const vendors = await listRealVendorsForMapping(admin.ctx.orgId);
      const target = vendors.find((v) => v.id === parsed.data.membershipId);
      if (!target) return { ok: false as const, message: "El vendedor no existe." };

      // Un agente Whaapy pertenece a un solo vendedor: evita mapeo duplicado.
      if (whaapyAgentId) {
        const clash = vendors.find(
          (v) => v.whaapy_agent_id === whaapyAgentId && v.id !== parsed.data.membershipId,
        );
        if (clash) {
          return {
            ok: false as const,
            message: `Ese agente ya está mapeado a ${clash.profile.full_name ?? "otro vendedor"}. Quítalo de ahí primero.`,
          };
        }
      }

      await updateMembershipWhaapyAgentId(admin.ctx.orgId, parsed.data.membershipId, whaapyAgentId);
      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "whaapy_agent_mapping_set",
        entityType: "membership",
        entityId: parsed.data.membershipId,
        payload: { whaapy_agent_id: whaapyAgentId } as Json,
      });
      revalidatePath("/admin/agentes-whaapy");
      return { ok: true as const, advisors: await loadAdvisors(admin.ctx.orgId) };
    },
    { source: "user_session" },
  );
}
