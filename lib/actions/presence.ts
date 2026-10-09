"use server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { resolveAdminContext } from "@/lib/auth/admin-guard";
import { withTenantContext } from "@/lib/tenant/context";
import {
  listActivitySessionsForUser,
  listLastSeenByUser,
  recordPresenceHeartbeat,
  type ActivitySession,
} from "@/lib/db/presence";
import { getOrganizationById } from "@/lib/db/organizations";
import { listManageableMemberships } from "@/lib/db/users";
import { readOrganizationTimezone } from "@/lib/services/organization-timezone";
import type { ISODateString, UUID } from "@/lib/types/database";

/**
 * Presencia de usuarios (0057).
 *
 * Tres actions: el latido que escribe, la lectura en lote para la columna
 * "última vez" y el historial de una persona.
 *
 * El latido lo invoca CUALQUIER usuario autenticado (es su propia presencia
 * la que registra, y el userId sale de la sesión, nunca del cliente). Las dos
 * lecturas son de la pestaña Admin → Usuarios.
 */

/**
 * Latido. Silencioso a propósito: si la sesión expiró o la BD falla, no hay
 * nada que mostrarle a la persona — está trabajando en otra pantalla y un
 * error de telemetría no debe interrumpirla. Devuelve si quedó registrado
 * para que el cliente pueda espaciar los reintentos.
 */
export async function presenceHeartbeatAction(): Promise<{ ok: boolean }> {
  const session = await getSession();
  if (session.status !== "ok") return { ok: false };
  const orgId = session.data.activeOrg.id;
  const userId = session.data.userId;
  try {
    await withTenantContext(orgId, () => recordPresenceHeartbeat(userId), {
      source: "user_session",
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export type TeamPresenceResult =
  | {
      ok: true;
      /** Reloj del SERVIDOR: el del navegador puede estar corrido. */
      now: ISODateString;
      timezone: string;
      /** userId → último latido. Ausente = sin actividad en la ventana. */
      lastSeen: Record<UUID, ISODateString>;
    }
  | { ok: false; message: string };

/**
 * Presencia de todo el equipo. La pantalla la re-pide cada tanto en vez de
 * recargar la página: lo único que cambia es la columna de presencia.
 */
export async function loadTeamPresenceAction(): Promise<TeamPresenceResult> {
  const admin = await resolveAdminContext("admin-usuarios");
  if (!admin.ok) return admin;
  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const memberships = await listManageableMemberships(admin.ctx.orgId);
      const lastSeen = await listLastSeenByUser(
        memberships.map((m) => m.user_id),
      );
      const timezone = readOrganizationTimezone(
        (await getOrganizationById(admin.ctx.orgId))?.config ?? null,
      );
      return {
        ok: true as const,
        now: new Date().toISOString(),
        timezone,
        lastSeen: Object.fromEntries(lastSeen),
      };
    },
    { source: "user_session" },
  );
}

const historySchema = z.object({
  membershipId: z.string().uuid("Usuario inválido."),
});

export type UserActivityResult =
  | {
      ok: true;
      now: ISODateString;
      timezone: string;
      sessions: ActivitySession[];
    }
  | { ok: false; message: string };

/**
 * Historial de tramos de una persona. Se pide por `membershipId` y no por
 * `userId`: la membresía es lo que pertenece a ESTA organización, así que
 * resolverla contra la lista gestionable es también la autorización — un id
 * de otro tenant no resuelve y no hay nada que filtrar.
 */
export async function loadUserActivityAction(
  raw: unknown,
): Promise<UserActivityResult> {
  const parsed = historySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Datos inválidos.",
    };
  }
  const admin = await resolveAdminContext("admin-usuarios");
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const memberships = await listManageableMemberships(admin.ctx.orgId);
      const target = memberships.find((m) => m.id === parsed.data.membershipId);
      if (!target) {
        return {
          ok: false as const,
          message: "El usuario ya no existe en la organización.",
        };
      }
      const sessions = await listActivitySessionsForUser(target.user_id);
      const timezone = readOrganizationTimezone(
        (await getOrganizationById(admin.ctx.orgId))?.config ?? null,
      );
      return {
        ok: true as const,
        now: new Date().toISOString(),
        timezone,
        sessions,
      };
    },
    { source: "user_session" },
  );
}
