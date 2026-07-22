"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenantContext } from "@/lib/tenant/context";
import { resolveAdminContext } from "@/lib/auth/admin-guard";
import { recordAuditEvent } from "@/lib/db/operational";
import {
  countMembershipsWithRoleKey,
  deleteRoleRow,
  getRoleById,
  insertRole,
  listRoles,
  updateRoleRow,
} from "@/lib/db/roles";
import { ALL_TAB_KEYS } from "@/lib/auth/capabilities";
import type { UUID } from "@/lib/types/database";
import type { RoleAdminView, RolesActionResult } from "@/lib/types/admin";

/**
 * Constructor de roles (Admin → Roles y permisos, 0039). Modelo de dos ejes
 * (pestañas + alcance de datos). Guardrails:
 *   - Roles de SISTEMA (admin/vendedor/superadmin): no se editan ni se borran.
 *   - Un rol con usuarios asignados no se puede borrar (resolver antes).
 *   - Un rol NUNCA se guarda sin pestañas (dejaría al usuario en estado roto).
 *   - `key` es inmutable; solo label/data_scope/allowed_tabs se editan.
 */

const TAB_SET = new Set(ALL_TAB_KEYS);

/** Slug ASCII estable a partir del label (sin acentos → '-'). */
function slugify(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "rol";
}

async function buildRolesView(orgId: UUID): Promise<RoleAdminView[]> {
  const rows = await listRoles(orgId);
  const views: RoleAdminView[] = [];
  for (const r of rows) {
    const userCount = await countMembershipsWithRoleKey(orgId, r.key);
    views.push({
      id: r.id,
      key: r.key,
      label: r.label,
      dataScope: r.data_scope,
      allowedTabs: r.allowed_tabs,
      isSystem: r.is_system,
      userCount,
    });
  }
  return views;
}

export async function loadAdminRoles(): Promise<RolesActionResult> {
  const admin = await resolveAdminContext("admin-roles");
  if (!admin.ok) return admin;
  return withTenantContext(
    admin.ctx.orgId,
    async () => ({ ok: true as const, roles: await buildRolesView(admin.ctx.orgId) }),
    { source: "user_session" },
  );
}

const tabsSchema = z
  .array(z.string())
  .min(1, "Elige al menos una pestaña.")
  .refine((tabs) => tabs.every((t) => TAB_SET.has(t)), "Pestaña desconocida.");

const createSchema = z.object({
  label: z.string().trim().min(1, "El nombre es obligatorio.").max(60),
  dataScope: z.enum(["own", "all"]),
  allowedTabs: tabsSchema,
});

export async function createRoleAction(raw: unknown): Promise<RolesActionResult> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Datos inválidos." };
  }
  const admin = await resolveAdminContext("admin-roles");
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      // Key única a partir del label (sufijo -2, -3… si colisiona).
      const existing = new Set((await listRoles(admin.ctx.orgId)).map((r) => r.key));
      const base = slugify(parsed.data.label);
      let key = base;
      let n = 2;
      while (existing.has(key)) key = `${base}-${n++}`;

      const dedupTabs = Array.from(new Set(parsed.data.allowedTabs));
      await insertRole({
        organizationId: admin.ctx.orgId,
        key,
        label: parsed.data.label,
        dataScope: parsed.data.dataScope,
        allowedTabs: dedupTabs,
      });
      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "role_created",
        entityType: "role",
        entityId: null,
        payload: { key, data_scope: parsed.data.dataScope, allowed_tabs: dedupTabs },
      });
      revalidatePath("/admin/roles");
      return { ok: true as const, roles: await buildRolesView(admin.ctx.orgId) };
    },
    { source: "user_session" },
  );
}

const updateSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1, "El nombre es obligatorio.").max(60),
  dataScope: z.enum(["own", "all"]),
  allowedTabs: tabsSchema,
});

export async function updateRoleAction(raw: unknown): Promise<RolesActionResult> {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Datos inválidos." };
  }
  const admin = await resolveAdminContext("admin-roles");
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const role = await getRoleById(admin.ctx.orgId, parsed.data.id);
      if (!role) return { ok: false as const, message: "El rol ya no existe." };
      if (role.is_system) {
        return {
          ok: false as const,
          message: "Los roles del sistema (admin, vendedor) no se pueden editar.",
        };
      }
      const dedupTabs = Array.from(new Set(parsed.data.allowedTabs));
      await updateRoleRow(admin.ctx.orgId, role.id, {
        label: parsed.data.label,
        dataScope: parsed.data.dataScope,
        allowedTabs: dedupTabs,
      });
      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "role_updated",
        entityType: "role",
        entityId: role.id,
        payload: { key: role.key, data_scope: parsed.data.dataScope, allowed_tabs: dedupTabs },
      });
      revalidatePath("/admin/roles");
      return { ok: true as const, roles: await buildRolesView(admin.ctx.orgId) };
    },
    { source: "user_session" },
  );
}

const deleteSchema = z.object({ id: z.string().uuid() });

export async function deleteRoleAction(raw: unknown): Promise<RolesActionResult> {
  const parsed = deleteSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos inválidos." };
  const admin = await resolveAdminContext("admin-roles");
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const role = await getRoleById(admin.ctx.orgId, parsed.data.id);
      if (!role) return { ok: false as const, message: "El rol ya no existe." };
      if (role.is_system) {
        return {
          ok: false as const,
          message: "Los roles del sistema (admin, vendedor) no se pueden borrar.",
        };
      }
      const userCount = await countMembershipsWithRoleKey(admin.ctx.orgId, role.key);
      if (userCount > 0) {
        return {
          ok: false as const,
          message: `Este rol tiene ${userCount} usuario(s). Cámbiales el rol antes de borrarlo.`,
        };
      }
      await deleteRoleRow(admin.ctx.orgId, role.id);
      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "role_deleted",
        entityType: "role",
        entityId: role.id,
        payload: { key: role.key },
      });
      revalidatePath("/admin/roles");
      return { ok: true as const, roles: await buildRolesView(admin.ctx.orgId) };
    },
    { source: "user_session" },
  );
}
