"use server";
import { getSession } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/tenant/context";
import { getMembership } from "@/lib/db/users";
import {
  loadAdminGoalProgress,
  loadVendorGoalProgress,
  type AdminGoalProgress,
  type VendorGoalProgress,
} from "@/lib/services/goal-progress";

/**
 * Carga del avance de metas para el Dashboard (M2v2 — Bloque 4). SIEMPRE el
 * mes en curso (CDMX), independiente del filtro de periodo del Dashboard —
 * por eso se carga aparte de `loadDashboardAction` y NO se re-pide al cambiar
 * filtros. Visibilidad por rol: admin ve equipo + cada vendedor; vendedor
 * solo lo suyo (forzado en la capa de servicio).
 */

export type DashboardGoalsView =
  | { isAdmin: true; data: AdminGoalProgress }
  | { isAdmin: false; data: VendorGoalProgress };

export type LoadDashboardGoalsResult =
  | { ok: true; view: DashboardGoalsView }
  | { ok: false; message: string };

export type LoadMyGoalResult =
  | { ok: true; data: VendorGoalProgress }
  | { ok: false; message: string };

/**
 * Avance de meta del USUARIO actual (su propia membership), para el widget
 * "Meta del mes" de Mi Día. Siempre vista-vendedor (su scope), sin importar el
 * rol: un admin sin meta asignada verá el empty state. Mes en curso.
 */
export async function loadMyGoalProgress(): Promise<LoadMyGoalResult> {
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, message: "Sesión expirada. Vuelve a iniciar sesión." };
  }
  const orgId = session.data.activeOrg.id;
  const userId = session.data.userId;
  return withTenantContext(
    orgId,
    async () => {
      const membership = await getMembership(userId, orgId);
      const data = await loadVendorGoalProgress(orgId, membership?.id ?? ("" as never));
      return { ok: true as const, data };
    },
    { source: "user_session" },
  );
}

export async function loadDashboardGoals(): Promise<LoadDashboardGoalsResult> {
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, message: "Sesión expirada. Vuelve a iniciar sesión." };
  }
  const orgId = session.data.activeOrg.id;
  const userId = session.data.userId;
  const role = session.data.activeOrg.role;
  const isAdmin = role === "admin" || role === "superadmin";

  return withTenantContext(
    orgId,
    async () => {
      if (isAdmin) {
        return { ok: true as const, view: { isAdmin: true as const, data: await loadAdminGoalProgress(orgId) } };
      }
      const membership = await getMembership(userId, orgId);
      const data = await loadVendorGoalProgress(orgId, membership?.id ?? ("" as never));
      return { ok: true as const, view: { isAdmin: false as const, data } };
    },
    { source: "user_session" },
  );
}
