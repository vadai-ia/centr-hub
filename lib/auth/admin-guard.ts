import "server-only";
import { getSession } from "@/lib/auth/session";
import {
  canAccessAdminPanel,
  canSeeAllData,
  hasTab,
  type RoleCapabilities,
} from "@/lib/auth/capabilities";
import type { UUID } from "@/lib/types/database";

/**
 * Guard compartido de las server actions de administración. Con roles
 * configurables (0039) el gate ya no es "role === admin" sino la presencia
 * de la pestaña correspondiente en el rol (Eje A). Cada grupo de actions
 * pasa su `requiredTab` (la key del TAB_REGISTRY que representa su pestaña).
 * Sin `requiredTab`, exige acceso a ALGUNA pestaña de administración.
 *
 * Vive fuera de los archivos `"use server"` (que solo exportan funciones
 * async) para poder compartirse entre los módulos de actions.
 */

export interface AdminContext {
  orgId: UUID;
  userId: UUID;
  role: RoleCapabilities;
}

export type AdminResolution =
  | { ok: true; ctx: AdminContext }
  | { ok: false; message: string };

export async function resolveAdminContext(
  requiredTab?: string,
): Promise<AdminResolution> {
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, message: "Sesión expirada. Vuelve a iniciar sesión." };
  }
  const role = session.data.activeRole;
  const allowed = requiredTab
    ? hasTab(role, requiredTab)
    : canAccessAdminPanel(role);
  if (!allowed) {
    return { ok: false, message: "No tienes permisos para esta sección." };
  }
  return {
    ok: true,
    ctx: { orgId: session.data.activeOrg.id, userId: session.data.userId, role },
  };
}

/**
 * Guard para acciones que operan sobre TODA la org sin ser de panel de
 * administración — el alcance de datos "all" (admin/superadmin/SDR). Ej.:
 * la vista de equipo de Mi Día, o asignar/reasignar oportunidades ajenas.
 * El SDR pasa esta guarda pero NO `resolveAdminContext` (no ve admin).
 */
export async function resolveSeesAllContext(): Promise<AdminResolution> {
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, message: "Sesión expirada. Vuelve a iniciar sesión." };
  }
  const role = session.data.activeRole;
  if (!canSeeAllData(role)) {
    return { ok: false, message: "No tienes permisos para esta sección." };
  }
  return {
    ok: true,
    ctx: { orgId: session.data.activeOrg.id, userId: session.data.userId, role },
  };
}
