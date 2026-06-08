"use server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/tenant/context";
import { getMembership, listRealVendorsForMapping } from "@/lib/db/users";
import { computeDashboardData } from "@/lib/services/dashboard-metrics";
import {
  PERIOD_PRESETS,
  resolveCustomPeriod,
  resolvePresetPeriod,
  type ResolvedPeriod,
} from "@/lib/time/period";
import { FUNNELS } from "@/lib/constants";
import type { UUID } from "@/lib/types/database";
import type { DashboardData, DashboardFiltersState } from "@/lib/types/dashboard";

/**
 * Server actions del Dashboard (M8.2).
 *
 * `loadDashboardAction` es el único punto de carga: resuelve sesión +
 * rol + tenant, traduce los filtros (periodo, asesor, funnel) a un
 * scope y delega el cómputo en `computeDashboardData`. El page la
 * invoca para el snapshot inicial y la UI la re-invoca al cambiar
 * cualquier filtro (sin polling — el dashboard es pull bajo demanda).
 */

export interface AdvisorOption {
  membershipId: UUID;
  name: string;
}

export interface DashboardLoadOk {
  ok: true;
  data: DashboardData;
  filters: DashboardFiltersState;
  advisors: AdvisorOption[];
  isAdmin: boolean;
}
export interface DashboardLoadErr {
  ok: false;
  reason: "no_session" | "invalid_input" | "invalid_period";
  message: string;
}
export type DashboardLoadResult = DashboardLoadOk | DashboardLoadErr;

const filtersSchema = z.object({
  funnel: z.enum(FUNNELS),
  preset: z.enum([...PERIOD_PRESETS, "custom"] as [string, ...string[]]),
  customFrom: z.string().nullable().optional(),
  customTo: z.string().nullable().optional(),
  // "" → todos; "unassigned" → sin asignar; uuid → asesor (solo admin).
  advisor: z.string().optional(),
});

export type DashboardFiltersInput = z.infer<typeof filtersSchema>;

function resolvePeriod(
  input: DashboardFiltersInput,
): { ok: true; period: ResolvedPeriod } | { ok: false } {
  if (input.preset === "custom") {
    if (!input.customFrom || !input.customTo) return { ok: false };
    const res = resolveCustomPeriod(input.customFrom, input.customTo);
    if (!res.ok) return { ok: false };
    return { ok: true, period: res.period };
  }
  return { ok: true, period: resolvePresetPeriod(input.preset as never) };
}

export async function loadDashboardAction(raw: unknown): Promise<DashboardLoadResult> {
  const parsed = filtersSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_input", message: "Filtros inválidos." };
  }
  const input = parsed.data;

  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, reason: "no_session", message: "Sesión expirada. Vuelve a iniciar sesión." };
  }

  const period = resolvePeriod(input);
  if (!period.ok) {
    return {
      ok: false,
      reason: "invalid_period",
      message: "Rango de fechas inválido: la fecha 'desde' debe ser anterior o igual a 'hasta'.",
    };
  }

  const orgId = session.data.activeOrg.id;
  const userId = session.data.userId;
  const role = session.data.activeOrg.role;
  const isAdmin = role === "admin" || role === "superadmin";

  return withTenantContext(orgId, async () => {
    // Vendedor: scope forzado a su propia membership; ignora filtro de
    // asesor. Admin: traduce el filtro de asesor a scope.
    let scope: UUID | "unassigned" | undefined;
    if (!isAdmin) {
      const membership = await getMembership(userId, orgId);
      scope = (membership?.id as UUID | undefined) ?? "unassigned";
    } else {
      const advisor = input.advisor ?? "";
      scope = advisor === "" ? undefined : advisor === "unassigned" ? "unassigned" : (advisor as UUID);
    }

    const data = await computeDashboardData({
      funnel: input.funnel,
      period: period.period,
      isAdmin,
      scope,
      organizationId: orgId,
    });

    const advisors: AdvisorOption[] = isAdmin
      ? (await listRealVendorsForMapping(orgId)).map((v) => ({
          membershipId: v.id,
          name: v.profile.full_name,
        }))
      : [];

    const filters: DashboardFiltersState = {
      funnel: input.funnel,
      preset: input.preset as DashboardFiltersState["preset"],
      customFrom: input.customFrom ?? null,
      customTo: input.customTo ?? null,
      advisorMembershipId:
        isAdmin && input.advisor && input.advisor !== "" && input.advisor !== "unassigned"
          ? (input.advisor as UUID)
          : null,
    };

    return { ok: true, data, filters, advisors, isAdmin };
  });
}
