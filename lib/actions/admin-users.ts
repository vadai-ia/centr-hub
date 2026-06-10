"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/tenant/context";
import {
  countActiveOpportunitiesByAdvisor,
  createMembership,
  createUserProfile,
  deleteAuthUser,
  getAuthUserInfo,
  inviteAuthUser,
  listManageableMemberships,
  repairAuthUserTokens,
  sendSetPasswordEmail,
  setAuthUserEmail,
  setMembershipActive,
  updateMembershipRole,
  updateUserProfile,
} from "@/lib/db/users";
import { listActiveOpportunitiesByAdvisor } from "@/lib/db/opportunities";
import { recordAuditEvent } from "@/lib/db/operational";
import { reassignOpportunityAdvisor } from "@/lib/services/opportunity-reassignment";
import type { UUID } from "@/lib/types/database";
import type {
  DeactivateUserResult,
  ManagedUserView,
  UserLoginStatus,
  UsersActionResult,
} from "@/lib/types/admin";

/**
 * Server actions de gestión de usuarios (M9.2, Block 1). Solo
 * admin/superadmin. Listar, editar (nombre/color) y cambiar rol entre
 * admin↔vendedor. El usuario sistema "Histórico" nunca aparece (R10).
 *
 * Invitaciones, vínculo a login existente y activar/desactivar viven en
 * los Blocks 2 y 3 (módulos separados que comparten este patrón).
 */

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/** URL base para los links de invitación/recuperación. Aterrizan en /auth/confirm. */
function confirmRedirectUrl(): string {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  return `${site}/auth/confirm`;
}

interface AdminCtx {
  orgId: UUID;
  userId: UUID;
}

async function resolveAdmin(): Promise<
  { ok: true; ctx: AdminCtx } | { ok: false; message: string }
> {
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, message: "Sesión expirada. Vuelve a iniciar sesión." };
  }
  const role = session.data.activeOrg.role;
  if (role !== "admin" && role !== "superadmin") {
    return { ok: false, message: "No tienes permisos de administrador." };
  }
  return {
    ok: true,
    ctx: { orgId: session.data.activeOrg.id, userId: session.data.userId },
  };
}

function deriveLoginStatus(info: {
  email: string | null;
  lastSignInAt: string | null;
  loadError: boolean;
}): UserLoginStatus {
  if (info.loadError || !info.email) return "placeholder";
  if (info.lastSignInAt) return "active";
  return "pending";
}

/**
 * Construye la lista de usuarios gestionables enriquecida con email,
 * estado de login y conteo de opps activas. Debe llamarse DENTRO de un
 * `withTenantContext`. Resiliente: una fila de auth no cargable
 * (placeholder) no rompe la lista, solo queda sin email.
 */
export async function buildManagedUsers(
  orgId: UUID,
  selfUserId: UUID,
): Promise<ManagedUserView[]> {
  const memberships = await listManageableMemberships(orgId);
  const activeOpps = await countActiveOpportunitiesByAdvisor(orgId);

  const users: ManagedUserView[] = [];
  for (const m of memberships) {
    const info = await getAuthUserInfo(m.user_id);
    users.push({
      membershipId: m.id,
      userId: m.user_id,
      fullName: m.profile.full_name,
      role: m.role,
      isActive: m.is_active,
      color: m.profile.color,
      email: info.email,
      loginStatus: deriveLoginStatus(info),
      isSelf: m.user_id === selfUserId,
      activeOpportunities: activeOpps.get(m.id) ?? 0,
    });
  }
  return users;
}

export async function loadAdminUsers(): Promise<UsersActionResult> {
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;
  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const users = await buildManagedUsers(admin.ctx.orgId, admin.ctx.userId);
      return { ok: true, users };
    },
    { source: "user_session" },
  );
}

const profileSchema = z.object({
  membershipId: z.string().uuid(),
  fullName: z.string().trim().min(1, "El nombre es obligatorio.").max(120),
  color: z.string().regex(HEX_COLOR, "Color inválido (usa formato #RRGGBB)."),
});

export async function updateUserProfileAction(
  raw: unknown,
): Promise<UsersActionResult> {
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Datos inválidos.",
    };
  }
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const memberships = await listManageableMemberships(admin.ctx.orgId);
      const target = memberships.find((m) => m.id === parsed.data.membershipId);
      if (!target) {
        return { ok: false, message: "El usuario ya no existe en la organización." };
      }
      await updateUserProfile(target.user_id, {
        full_name: parsed.data.fullName,
        color: parsed.data.color,
      });
      revalidatePath("/admin/usuarios");
      const users = await buildManagedUsers(admin.ctx.orgId, admin.ctx.userId);
      return { ok: true, users };
    },
    { source: "user_session" },
  );
}

const roleSchema = z.object({
  membershipId: z.string().uuid(),
  // V1: solo admin y vendedor son asignables desde la UI.
  role: z.enum(["admin", "vendedor"]),
});

export async function updateUserRoleAction(
  raw: unknown,
): Promise<UsersActionResult> {
  const parsed = roleSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: "Rol inválido (solo admin o vendedor en V1)." };
  }
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const memberships = await listManageableMemberships(admin.ctx.orgId);
      const target = memberships.find((m) => m.id === parsed.data.membershipId);
      if (!target) {
        return { ok: false, message: "El usuario ya no existe en la organización." };
      }
      // No te cambies tu propio rol (evita auto-bloqueo accidental).
      if (target.user_id === admin.ctx.userId) {
        return {
          ok: false,
          message: "No puedes cambiar tu propio rol.",
        };
      }
      // No gestionamos superadmin desde V1.
      if (target.role === "superadmin") {
        return {
          ok: false,
          message: "El rol superadmin no se gestiona desde esta pantalla.",
        };
      }
      if (target.role === parsed.data.role) {
        const users = await buildManagedUsers(admin.ctx.orgId, admin.ctx.userId);
        return { ok: true, users };
      }
      // No dejes la org sin ningún admin ACTIVO.
      if (target.role === "admin" && parsed.data.role === "vendedor") {
        const otherActiveAdmins = memberships.filter(
          (m) =>
            m.id !== target.id &&
            m.is_active &&
            (m.role === "admin" || m.role === "superadmin"),
        );
        if (otherActiveAdmins.length === 0) {
          return {
            ok: false,
            message:
              "No puedes quitar el último administrador activo. Asigna otro admin primero.",
          };
        }
      }
      await updateMembershipRole(target.id, parsed.data.role);
      revalidatePath("/admin/usuarios");
      const users = await buildManagedUsers(admin.ctx.orgId, admin.ctx.userId);
      return { ok: true, users };
    },
    { source: "user_session" },
  );
}

// ============================================================
// Invitaciones + vínculo de login (M9.2, Block 2)
// ============================================================

const inviteSchema = z.object({
  fullName: z.string().trim().min(1, "El nombre es obligatorio.").max(120),
  email: z.string().trim().email("Email inválido."),
  color: z.string().regex(HEX_COLOR, "Color inválido (usa formato #RRGGBB)."),
});

/**
 * Invita un vendedor NUEVO por email (Supabase built-in). Crea la fila
 * de auth + user_profile + membership(role=vendedor, activo). Si la
 * creación de perfil/membership falla tras crear el auth user, se
 * compensa borrando el auth user para no dejar huérfanos.
 */
export async function inviteVendorAction(
  raw: unknown,
): Promise<UsersActionResult> {
  const parsed = inviteSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Datos inválidos.",
    };
  }
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;

  const email = parsed.data.email.toLowerCase();

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const invited = await inviteAuthUser(
        email,
        parsed.data.fullName,
        confirmRedirectUrl(),
      );
      if (!invited.ok) {
        const already = /already|registered|exists/i.test(invited.message);
        return {
          ok: false,
          message: already
            ? "Ese email ya tiene una cuenta. Si es un asesor existente, usa “Vincular login”."
            : `No se pudo enviar la invitación: ${invited.message}`,
        };
      }

      try {
        await createUserProfile({
          id: invited.userId,
          full_name: parsed.data.fullName,
          phone: null,
          avatar_url: null,
          color: parsed.data.color,
          is_system_user: false,
        });
        await createMembership({
          user_id: invited.userId,
          organization_id: admin.ctx.orgId,
          role: "vendedor",
          is_active: true,
          whaapy_agent_id: null,
        });
      } catch (e) {
        // Compensación: el auth user quedó creado pero no su perfil/membership.
        await deleteAuthUser(invited.userId).catch(() => {});
        return {
          ok: false,
          message:
            e instanceof Error
              ? `No se pudo crear el usuario: ${e.message}`
              : "No se pudo crear el usuario.",
        };
      }

      revalidatePath("/admin/usuarios");
      const users = await buildManagedUsers(admin.ctx.orgId, admin.ctx.userId);
      return { ok: true, users };
    },
    { source: "user_session" },
  );
}

const linkSchema = z.object({
  membershipId: z.string().uuid(),
  email: z.string().trim().email("Email inválido."),
});

/**
 * Vincula un login a un asesor EXISTENTE (Gina/Pepe) sin duplicar su
 * entidad. Repair-in-place: (1) repara la fila auth cruda (migracion
 * 0028), (2) le fija el email real, (3) envía el link de definir
 * contraseña. El user_id no cambia → atribuciones intactas.
 */
export async function linkExistingAdvisorAction(
  raw: unknown,
): Promise<UsersActionResult> {
  const parsed = linkSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Datos inválidos.",
    };
  }
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;

  const email = parsed.data.email.toLowerCase();

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const memberships = await listManageableMemberships(admin.ctx.orgId);
      const target = memberships.find((m) => m.id === parsed.data.membershipId);
      if (!target) {
        return { ok: false, message: "El usuario ya no existe en la organización." };
      }

      // (1) Reparar la fila auth para que GoTrue la pueda cargar/editar.
      try {
        await repairAuthUserTokens(target.user_id);
      } catch (e) {
        return {
          ok: false,
          message:
            "No se pudo reparar la cuenta de auth. ¿Aplicaste la migración 0028? " +
            (e instanceof Error ? `Detalle: ${e.message}` : ""),
        };
      }

      // (2) Fijar el email real en la fila existente (mismo user_id).
      const setEmail = await setAuthUserEmail(
        target.user_id,
        email,
        target.profile.full_name,
      );
      if (!setEmail.ok) {
        return {
          ok: false,
          message: `No se pudo asignar el email: ${setEmail.message}`,
        };
      }

      // (3) Enviar el link de definir contraseña (Supabase built-in).
      const sent = await sendSetPasswordEmail(email, confirmRedirectUrl());
      if (!sent.ok) {
        return {
          ok: false,
          message:
            `El email se vinculó pero no se pudo enviar el link: ${sent.message}. ` +
            "Usa “Reenviar invitación”.",
        };
      }

      revalidatePath("/admin/usuarios");
      const users = await buildManagedUsers(admin.ctx.orgId, admin.ctx.userId);
      return { ok: true, users };
    },
    { source: "user_session" },
  );
}

const resendSchema = z.object({ membershipId: z.string().uuid() });

/** Reenvía el link de definir contraseña a un usuario que ya tiene email. */
export async function resendInviteAction(
  raw: unknown,
): Promise<UsersActionResult> {
  const parsed = resendSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: "Datos inválidos." };
  }
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const memberships = await listManageableMemberships(admin.ctx.orgId);
      const target = memberships.find((m) => m.id === parsed.data.membershipId);
      if (!target) {
        return { ok: false, message: "El usuario ya no existe en la organización." };
      }
      const info = await getAuthUserInfo(target.user_id);
      if (info.loadError || !info.email) {
        return {
          ok: false,
          message:
            "Este usuario no tiene un email vinculado todavía. Usa “Vincular login”.",
        };
      }
      const sent = await sendSetPasswordEmail(info.email, confirmRedirectUrl());
      if (!sent.ok) {
        return {
          ok: false,
          message: `No se pudo reenviar: ${sent.message}`,
        };
      }
      const users = await buildManagedUsers(admin.ctx.orgId, admin.ctx.userId);
      return { ok: true, users };
    },
    { source: "user_session" },
  );
}

// ============================================================
// Activar / Desactivar con reasignación previa (M9.2, Block 3 — opción C)
// ============================================================

const membershipIdSchema = z.object({ membershipId: z.string().uuid() });

/**
 * Desactiva un usuario (pierde acceso; NUNCA se borra). Bloqueado si
 * tiene oportunidades activas asignadas → la UI ofrece reasignarlas
 * primero. No puedes desactivarte a ti mismo ni al último admin activo.
 */
export async function deactivateUserAction(
  raw: unknown,
): Promise<DeactivateUserResult> {
  const parsed = membershipIdSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "internal_error", message: "Datos inválidos." };
  }
  const admin = await resolveAdmin();
  if (!admin.ok) {
    return { ok: false, reason: "forbidden", message: admin.message };
  }

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const memberships = await listManageableMemberships(admin.ctx.orgId);
      const target = memberships.find((m) => m.id === parsed.data.membershipId);
      if (!target) {
        return { ok: false, reason: "not_found", message: "El usuario ya no existe." };
      }
      if (!target.is_active) {
        // Ya inactivo — idempotente.
        const users = await buildManagedUsers(admin.ctx.orgId, admin.ctx.userId);
        return { ok: true, users };
      }
      if (target.user_id === admin.ctx.userId) {
        return {
          ok: false,
          reason: "forbidden",
          message: "No puedes desactivar tu propia cuenta.",
        };
      }
      if (target.role === "admin" || target.role === "superadmin") {
        const otherActiveAdmins = memberships.filter(
          (m) =>
            m.id !== target.id &&
            m.is_active &&
            (m.role === "admin" || m.role === "superadmin"),
        );
        if (otherActiveAdmins.length === 0) {
          return {
            ok: false,
            reason: "last_admin",
            message:
              "No puedes desactivar el último administrador activo de la organización.",
          };
        }
      }

      const activeOpps = await listActiveOpportunitiesByAdvisor(target.id);
      if (activeOpps.length > 0) {
        return {
          ok: false,
          reason: "has_pending",
          activeCount: activeOpps.length,
          message: `${target.profile.full_name} tiene ${activeOpps.length} oportunidad(es) activa(s). Reasígnalas antes de desactivar.`,
        };
      }

      await setMembershipActive(target.id, false);
      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "user_deactivated",
        entityType: "membership",
        entityId: target.id,
        payload: { user_id: target.user_id, role: target.role },
      });
      revalidatePath("/admin/usuarios");
      const users = await buildManagedUsers(admin.ctx.orgId, admin.ctx.userId);
      return { ok: true, users };
    },
    { source: "user_session" },
  );
}

/** Reactiva un usuario previamente desactivado. */
export async function activateUserAction(
  raw: unknown,
): Promise<UsersActionResult> {
  const parsed = membershipIdSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos inválidos." };
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const memberships = await listManageableMemberships(admin.ctx.orgId);
      const target = memberships.find((m) => m.id === parsed.data.membershipId);
      if (!target) {
        return { ok: false, message: "El usuario ya no existe." };
      }
      if (target.is_active) {
        const users = await buildManagedUsers(admin.ctx.orgId, admin.ctx.userId);
        return { ok: true, users };
      }
      await setMembershipActive(target.id, true);
      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "user_reactivated",
        entityType: "membership",
        entityId: target.id,
        payload: { user_id: target.user_id, role: target.role },
      });
      revalidatePath("/admin/usuarios");
      const users = await buildManagedUsers(admin.ctx.orgId, admin.ctx.userId);
      return { ok: true, users };
    },
    { source: "user_session" },
  );
}

const reassignAllSchema = z.object({
  fromMembershipId: z.string().uuid(),
  toMembershipId: z.string().uuid(),
  deactivateAfter: z.boolean().optional(),
});

/**
 * Reasigna TODAS las oportunidades activas de un vendedor a otro
 * (reasignación manual — los hooks no la pisan, vía el núcleo
 * compartido). Si `deactivateAfter`, desactiva al origen al terminar.
 * Usado desde el flujo de desactivación con pendientes (opción C).
 */
export async function reassignActiveOpportunitiesAction(
  raw: unknown,
): Promise<UsersActionResult> {
  const parsed = reassignAllSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos inválidos." };
  if (parsed.data.fromMembershipId === parsed.data.toMembershipId) {
    return { ok: false, message: "Elige un asesor distinto al actual." };
  }
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const memberships = await listManageableMemberships(admin.ctx.orgId);
      const from = memberships.find((m) => m.id === parsed.data.fromMembershipId);
      const to = memberships.find((m) => m.id === parsed.data.toMembershipId);
      if (!from || !to) {
        return { ok: false, message: "El asesor origen o destino ya no existe." };
      }
      if (!to.is_active) {
        return {
          ok: false,
          message: "No puedes reasignar a un asesor desactivado.",
        };
      }

      const activeOpps = await listActiveOpportunitiesByAdvisor(from.id);
      let failures = 0;
      for (const opp of activeOpps) {
        const res = await reassignOpportunityAdvisor({
          opportunityId: opp.id,
          newMembershipId: to.id,
          actorUserId: admin.ctx.userId,
        });
        if (!res.ok) failures += 1;
      }
      if (failures > 0) {
        revalidatePath("/admin/usuarios");
        const users = await buildManagedUsers(admin.ctx.orgId, admin.ctx.userId);
        void users;
        return {
          ok: false,
          message: `No se pudieron reasignar ${failures} de ${activeOpps.length} oportunidades. No se desactivó al vendedor; reintenta.`,
        };
      }

      if (parsed.data.deactivateAfter) {
        // Re-chequear pendientes (defensivo) antes de desactivar.
        const stillActive = await listActiveOpportunitiesByAdvisor(from.id);
        if (stillActive.length === 0 && from.user_id !== admin.ctx.userId) {
          await setMembershipActive(from.id, false);
          await recordAuditEvent({
            actorUserId: admin.ctx.userId,
            eventType: "user_deactivated",
            entityType: "membership",
            entityId: from.id,
            payload: {
              user_id: from.user_id,
              role: from.role,
              reassigned_to: to.id,
              reassigned_count: activeOpps.length,
            },
          });
        }
      }

      revalidatePath("/admin/usuarios");
      const users = await buildManagedUsers(admin.ctx.orgId, admin.ctx.userId);
      return { ok: true, users };
    },
    { source: "user_session" },
  );
}
