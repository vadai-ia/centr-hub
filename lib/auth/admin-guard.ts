import "server-only";
import { getSession } from "@/lib/auth/session";
import type { UUID } from "@/lib/types/database";

/**
 * Guard compartido de las server actions de administración (M7.2).
 * Resuelve sesión + rol admin/superadmin. Vive fuera de los archivos
 * `"use server"` (que solo exportan funciones async) para poder
 * compartirse entre los módulos de actions de etapas, motivos y tags.
 */

export interface AdminContext {
  orgId: UUID;
  userId: UUID;
}

export type AdminResolution =
  | { ok: true; ctx: AdminContext }
  | { ok: false; message: string };

export async function resolveAdminContext(): Promise<AdminResolution> {
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
