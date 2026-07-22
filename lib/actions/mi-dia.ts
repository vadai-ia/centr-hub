"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { canSeeAllData } from "@/lib/auth/capabilities";
import { withTenantContext } from "@/lib/tenant/context";
import { getMembership } from "@/lib/db/users";
import {
  getTaskById,
  updateTask,
  getNotificationById,
  updateNotification,
  recordAuditEvent,
} from "@/lib/db/operational";
import { loadMiDiaForUser, type MiDiaData } from "@/lib/services/mi-dia";
import { snoozeUntilUtc } from "@/lib/time/period";

/**
 * Server actions de Mi Día (M1v2, Bloque B). El completar/crear tareas
 * reusa las acciones de V1 (`opportunities-m6`) para que el detalle y el
 * pipeline queden en sync. Aquí viven: carga del tablero, snooze (tarea y
 * aviso) y cierre/descarte de avisos.
 */

export type MiDiaLoadResult =
  | { ok: true; data: MiDiaData }
  | { ok: false; message: string };

export type MiDiaMutationResult =
  | { ok: true }
  | { ok: false; message: string };

async function resolveActor(): Promise<
  | { ok: true; orgId: string; userId: string; membershipId: string | null; isAdmin: boolean }
  | { ok: false; message: string }
> {
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, message: "Sesión expirada. Vuelve a iniciar sesión." };
  }
  const orgId = session.data.activeOrg.id;
  const userId = session.data.userId;
  // "Sees all" (admin/superadmin/SDR) puede operar tareas/avisos de
  // cualquiera; "own" (vendedor) solo los suyos (0039).
  const isAdmin = canSeeAllData(session.data.activeRole);
  const membership = await withTenantContext(
    orgId,
    () => getMembership(userId, orgId),
    { source: "user_session" },
  );
  return { ok: true, orgId, userId, membershipId: membership?.id ?? null, isAdmin };
}

export async function loadMiDiaAction(): Promise<MiDiaLoadResult> {
  const actor = await resolveActor();
  if (!actor.ok) return actor;
  return withTenantContext(
    actor.orgId,
    async () => ({
      ok: true as const,
      data: await loadMiDiaForUser({
        userId: actor.userId,
        advisorMembershipId: actor.membershipId,
      }),
    }),
    { source: "user_session" },
  );
}

const snoozeSchema = z.object({
  id: z.string().uuid(),
  option: z.enum(["1h", "3h", "tomorrow"]),
});

export async function snoozeTaskAction(raw: unknown): Promise<MiDiaMutationResult> {
  const parsed = snoozeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Parámetros inválidos." };
  const actor = await resolveActor();
  if (!actor.ok) return actor;

  return withTenantContext(
    actor.orgId,
    async () => {
      const task = await getTaskById(parsed.data.id);
      if (!task) return { ok: false as const, message: "La tarea ya no existe." };
      if (!actor.isAdmin && task.assigned_user_id !== actor.userId) {
        return { ok: false as const, message: "No tienes acceso a esta tarea." };
      }
      await updateTask(parsed.data.id, {
        status: "snoozed",
        snoozed_until: snoozeUntilUtc(parsed.data.option),
      });
      revalidatePath("/mi-dia");
      return { ok: true as const };
    },
    { source: "user_session" },
  );
}

export async function snoozeNotificationAction(
  raw: unknown,
): Promise<MiDiaMutationResult> {
  const parsed = snoozeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Parámetros inválidos." };
  const actor = await resolveActor();
  if (!actor.ok) return actor;

  return withTenantContext(
    actor.orgId,
    async () => {
      const notif = await getNotificationById(parsed.data.id);
      if (!notif) return { ok: false as const, message: "El aviso ya no existe." };
      if (!actor.isAdmin && notif.user_id !== actor.userId) {
        return { ok: false as const, message: "No tienes acceso a este aviso." };
      }
      await updateNotification(parsed.data.id, {
        status: "snoozed",
        snoozed_until: snoozeUntilUtc(parsed.data.option),
      });
      revalidatePath("/mi-dia");
      return { ok: true as const };
    },
    { source: "user_session" },
  );
}

const notifIdSchema = z.object({ id: z.string().uuid() });

async function setNotificationStatus(
  raw: unknown,
  status: "completed" | "dismissed",
  event: string,
): Promise<MiDiaMutationResult> {
  const parsed = notifIdSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Parámetros inválidos." };
  const actor = await resolveActor();
  if (!actor.ok) return actor;

  return withTenantContext(
    actor.orgId,
    async () => {
      const notif = await getNotificationById(parsed.data.id);
      if (!notif) return { ok: false as const, message: "El aviso ya no existe." };
      if (!actor.isAdmin && notif.user_id !== actor.userId) {
        return { ok: false as const, message: "No tienes acceso a este aviso." };
      }
      await updateNotification(parsed.data.id, {
        status,
        completed_at: status === "completed" ? new Date().toISOString() : null,
        snoozed_until: null,
      });
      await recordAuditEvent({
        actorUserId: actor.userId,
        eventType: event,
        entityType: "notification",
        entityId: parsed.data.id,
        payload: {},
      });
      revalidatePath("/mi-dia");
      return { ok: true as const };
    },
    { source: "user_session" },
  );
}

export async function completeNotificationAction(
  raw: unknown,
): Promise<MiDiaMutationResult> {
  return setNotificationStatus(raw, "completed", "notification_completed");
}

export async function dismissNotificationAction(
  raw: unknown,
): Promise<MiDiaMutationResult> {
  return setNotificationStatus(raw, "dismissed", "notification_dismissed");
}
