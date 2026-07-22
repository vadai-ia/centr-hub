"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import {
  EMAIL_RATE_LIMIT_MESSAGE,
  isEmailRateLimit,
} from "@/lib/auth/email-send-errors";
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
import { listRoles } from "@/lib/db/roles";
import { recordAuditEvent } from "@/lib/db/operational";
import { reassignOpportunityAdvisor } from "@/lib/services/opportunity-reassignment";
import { hasTab } from "@/lib/auth/capabilities";
import type { RoleRow, UUID } from "@/lib/types/database";
import type {
  DeactivateUserResult,
  LoadAdminUsersResult,
  ManagedUserView,
  RoleOption,
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
  // Gate por pestaña (0039): gestionar usuarios exige la pestaña Usuarios.
  if (!hasTab(session.data.activeRole, "admin-usuarios")) {
    return { ok: false, message: "No tienes permisos para gestionar usuarios." };
  }
  return {
    ok: true,
    ctx: { orgId: session.data.activeOrg.id, userId: session.data.userId },
  };
}

/** Mapa key→RoleRow de los roles de la org (labels + capacidades). */
async function loadOrgRolesMap(orgId: UUID): Promise<Map<string, RoleRow>> {
  const rows = await listRoles(orgId);
  return new Map(rows.map((r) => [r.key, r]));
}

function roleLabelOf(rolesMap: Map<string, RoleRow>, key: string): string {
  return rolesMap.get(key)?.label ?? key;
}

/**
 * ¿Un rol puede GESTIONAR usuarios? = tiene la pestaña Usuarios. Es el
 * invariante que sustituye al viejo "es admin/superadmin" en los guardrails
 * de último-administrador (no dejar la org sin quien administre usuarios).
 */
function roleCanManageUsers(rolesMap: Map<string, RoleRow>, key: string): boolean {
  const r = rolesMap.get(key);
  return !!r && r.allowed_tabs.includes("admin-usuarios");
}

/** Roles asignables desde la UI: todos los de la org excepto superadmin. */
function assignableRolesFrom(rows: RoleRow[]): RoleOption[] {
  return rows
    .filter((r) => r.key !== "superadmin")
    .map((r) => ({
      key: r.key,
      label: r.label,
      isSystem: r.is_system,
      dataScope: r.data_scope,
    }));
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
  rolesMap?: Map<string, RoleRow>,
): Promise<ManagedUserView[]> {
  const memberships = await listManageableMemberships(orgId);
  const activeOpps = await countActiveOpportunitiesByAdvisor(orgId);
  const map = rolesMap ?? (await loadOrgRolesMap(orgId));

  const users: ManagedUserView[] = [];
  for (const m of memberships) {
    const info = await getAuthUserInfo(m.user_id);
    users.push({
      membershipId: m.id,
      userId: m.user_id,
      fullName: m.profile.full_name,
      role: m.role,
      roleLabel: roleLabelOf(map, m.role),
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

export async function loadAdminUsers(): Promise<LoadAdminUsersResult> {
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;
  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const roleRows = await listRoles(admin.ctx.orgId);
      const rolesMap = new Map(roleRows.map((r) => [r.key, r]));
      const users = await buildManagedUsers(
        admin.ctx.orgId,
        admin.ctx.userId,
        rolesMap,
      );
      return {
        ok: true as const,
        users,
        assignableRoles: assignableRolesFrom(roleRows),
      };
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

const emailSchema = z.object({
  membershipId: z.string().uuid(),
  email: z.string().trim().email("Email inválido."),
});

/**
 * Edita el correo (credencial de login) de un usuario gestionable. El
 * correo NO es un campo de perfil — vive en `auth.users`, así que se
 * sincroniza con GoTrue. Ramifica por estado de la fila auth:
 *   - placeholder (fila cruda no cargable): la repara (migración 0028) y
 *     le fija el email → pasa a "pendiente"; el admin envía el acceso con
 *     "Reenviar".
 *   - pending/active: fija el email vía `updateUserById` (email_confirm),
 *     SIN tocar el `user_id` → atribución intacta. Un usuario ya activo
 *     iniciará sesión con el correo nuevo (no se invalida su sesión: el
 *     RLS depende de organization_id, no del email).
 * Valida formato (Zod) y rechaza duplicados (otro usuario con ese correo,
 * detectado por el error de GoTrue). No envía ningún email: el envío del
 * acceso queda como acción explícita ("Reenviar"/"Invitar").
 */
export async function updateUserEmailAction(
  raw: unknown,
): Promise<UsersActionResult> {
  const parsed = emailSchema.safeParse(raw);
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

      const info = await getAuthUserInfo(target.user_id);
      // Idempotente: ya tiene exactamente ese correo → nada que hacer.
      if (!info.loadError && info.email?.toLowerCase() === email) {
        const users = await buildManagedUsers(admin.ctx.orgId, admin.ctx.userId);
        return { ok: true, users };
      }

      // Fila cruda (placeholder) no cargable → repararla antes de editar.
      if (info.loadError) {
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
      }

      const setEmail = await setAuthUserEmail(
        target.user_id,
        email,
        target.profile.full_name,
      );
      if (!setEmail.ok) {
        const dup = /already|registered|exists|duplicate|in use/i.test(
          setEmail.message,
        );
        return {
          ok: false,
          message: dup
            ? "Ese correo ya está en uso por otra cuenta. Usa un correo distinto."
            : `No se pudo actualizar el correo: ${setEmail.message}`,
        };
      }

      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "user_email_updated",
        entityType: "membership",
        entityId: target.id,
        payload: { user_id: target.user_id, new_email: email },
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
  // Cualquier rol de la org; se valida en runtime contra `roles`. superadmin
  // NO es asignable desde la UI (0039).
  role: z.string().trim().min(1),
});

export async function updateUserRoleAction(
  raw: unknown,
): Promise<UsersActionResult> {
  const parsed = roleSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: "Rol inválido." };
  }
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const rolesMap = await loadOrgRolesMap(admin.ctx.orgId);
      const newRole = rolesMap.get(parsed.data.role);
      if (!newRole || newRole.key === "superadmin") {
        return { ok: false, message: "Rol inválido o no asignable." };
      }
      const memberships = await listManageableMemberships(admin.ctx.orgId);
      const target = memberships.find((m) => m.id === parsed.data.membershipId);
      if (!target) {
        return { ok: false, message: "El usuario ya no existe en la organización." };
      }
      // No te cambies tu propio rol (evita auto-bloqueo accidental).
      if (target.user_id === admin.ctx.userId) {
        return { ok: false, message: "No puedes cambiar tu propio rol." };
      }
      // No gestionamos superadmin desde esta pantalla.
      if (target.role === "superadmin") {
        return {
          ok: false,
          message: "El rol superadmin no se gestiona desde esta pantalla.",
        };
      }
      if (target.role === newRole.key) {
        const users = await buildManagedUsers(
          admin.ctx.orgId,
          admin.ctx.userId,
          rolesMap,
        );
        return { ok: true, users };
      }
      // No dejes la org sin ningún usuario ACTIVO que pueda gestionar usuarios.
      if (
        roleCanManageUsers(rolesMap, target.role) &&
        !roleCanManageUsers(rolesMap, newRole.key)
      ) {
        const othersCanManage = memberships.filter(
          (m) =>
            m.id !== target.id &&
            m.is_active &&
            roleCanManageUsers(rolesMap, m.role),
        );
        if (othersCanManage.length === 0) {
          return {
            ok: false,
            message:
              "No puedes quitar el último usuario que puede gestionar usuarios. Asigna a otro primero.",
          };
        }
      }
      await updateMembershipRole(target.id, newRole.key);
      revalidatePath("/admin/usuarios");
      const users = await buildManagedUsers(
        admin.ctx.orgId,
        admin.ctx.userId,
        rolesMap,
      );
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
  // Rol del invitado: cualquier rol de la org (validado en runtime),
  // excepto superadmin. Antes estaba cableado a "vendedor" (0039).
  role: z.string().trim().min(1, "Elige un rol."),
});

/**
 * Invita un usuario NUEVO por email (Supabase built-in) con el rol elegido.
 * Crea la fila de auth + user_profile + membership(role, activo). Si la
 * creación de perfil/membership falla tras crear el auth user, se compensa
 * borrando el auth user para no dejar huérfanos. El rol se valida contra la
 * tabla `roles` de la org (superadmin no es invitable).
 */
export async function inviteUserAction(
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
      const rolesMap = await loadOrgRolesMap(admin.ctx.orgId);
      const role = rolesMap.get(parsed.data.role);
      if (!role || role.key === "superadmin") {
        return { ok: false, message: "Rol inválido o no asignable." };
      }

      const invited = await inviteAuthUser(
        email,
        parsed.data.fullName,
        confirmRedirectUrl(),
      );
      if (!invited.ok) {
        const already = /already|registered|exists/i.test(invited.message);
        return {
          ok: false,
          message: isEmailRateLimit(invited.message)
            ? EMAIL_RATE_LIMIT_MESSAGE
            : already
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
          role: role.key,
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
          message: isEmailRateLimit(sent.message)
            ? "El email se vinculó, pero el link no se pudo enviar: límite de envío de correos alcanzado. Espera ~1 hora y usa “Reenviar invitación”."
            : `El email se vinculó pero no se pudo enviar el link: ${sent.message}. ` +
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
          message: isEmailRateLimit(sent.message)
            ? EMAIL_RATE_LIMIT_MESSAGE
            : `No se pudo reenviar: ${sent.message}`,
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
      const rolesMap = await loadOrgRolesMap(admin.ctx.orgId);
      if (roleCanManageUsers(rolesMap, target.role)) {
        const othersCanManage = memberships.filter(
          (m) =>
            m.id !== target.id &&
            m.is_active &&
            roleCanManageUsers(rolesMap, m.role),
        );
        if (othersCanManage.length === 0) {
          return {
            ok: false,
            reason: "last_admin",
            message:
              "No puedes desactivar el último usuario que puede gestionar usuarios de la organización.",
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
      // Solo vendedores son asesores asignables (0039): no reasignar a un
      // SDR/admin (no es dueño de oportunidades).
      if (to.role !== "vendedor") {
        return {
          ok: false,
          message: "Solo puedes reasignar oportunidades a un vendedor.",
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
