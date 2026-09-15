import "server-only";
import {
  computeGoalAchievement,
  type GoalScope,
  type ScopeAchievement,
} from "@/lib/services/dashboard-metrics";
import { achievedForMetric, closeRateOf, type CloseRate } from "@/lib/metas/achievement";
import { readGoalThresholds } from "@/lib/services/metas-config";
import { listGoals } from "@/lib/db/metas";
import { getOrganizationById } from "@/lib/db/organizations";
import { listRealVendorsForMapping } from "@/lib/db/users";
import {
  computeGoalPct,
  resolveGoalZone,
  type GoalThresholds,
  type GoalZone,
} from "@/lib/metas/semaphore";
import { isEditableGoalMetric, type GoalMetric, type GoalSubject } from "@/lib/metas/schema";
import {
  currentMonthKey,
  resolveCurrentMonthPeriod,
  resolveMonthPeriod,
  type ResolvedPeriod,
} from "@/lib/time/period";
import type { GoalRow, UUID } from "@/lib/types/database";

/**
 * Servicio de avance de metas (M2v2 — Bloque 2). Ensambla, para el MES EN
 * CURSO (CDMX), el avance de cada meta activa reusando las fuentes del
 * Dashboard (`computeGoalAchievement`) — NO recomputa métricas.
 *
 * Requiere ejecutarse dentro de `withTenantContext(orgId, ...)` (listGoals es
 * tenant-scoped). El avance es SIEMPRE del mes corriente, independiente del
 * filtro de periodo del Dashboard.
 *
 * Visibilidad (a nivel data, no UI):
 *  - Admin: `loadAdminGoalProgress` → meta de equipo + la de cada vendedor.
 *  - Vendedor: `loadVendorGoalProgress` → SOLO sus propias metas; nunca la de
 *    equipo ni la de otros vendedores.
 */

export interface GoalProgress {
  goalId: UUID;
  /** Sujeto explícito (0051): equipo, un vendedor, o la venta orgánica. */
  subject: GoalSubject;
  advisorMembershipId: UUID | null; // null salvo subject 'advisor'
  advisorName: string | null; // nombre del vendedor (vista admin); null si no aplica
  metric: GoalMetric;
  target: number;
  achieved: number;
  pct: number | null; // null si target <= 0 (sin meta medible → empty state)
  zone: GoalZone | null; // null cuando pct es null
}

export interface VendorGoals {
  membershipId: UUID;
  name: string;
  color: string | null;
  goals: GoalProgress[];
  /** % de cierre automático del mes (sin objetivo). */
  closeRate: CloseRate;
}

export interface AdminGoalProgress {
  thresholds: GoalThresholds;
  monthKey: string; // yyyy-MM del mes en curso (MX)
  team: GoalProgress[]; // metas de la organización completa
  /** Meta(s) de la venta que entra sola por la tienda online (0051). */
  organic: GoalProgress[];
  /** Vendedores con al menos una meta activa O con cotizaciones en el mes. */
  byVendor: VendorGoals[];
  /** % de cierre automático de toda la organización en el mes. */
  teamCloseRate: CloseRate;
}

export interface VendorGoalProgress {
  thresholds: GoalThresholds;
  monthKey: string;
  goals: GoalProgress[]; // SOLO las del vendedor
  /** Su % de cierre automático del mes (aunque no tenga metas). */
  closeRate: CloseRate;
}

/** Fila del % de cierre de un mes cualquiera (Admin → Metas, meses cerrados). */
export interface CloseRateRow {
  key: string; // "team" | membershipId
  subject: "team" | "advisor";
  name: string;
  color: string | null;
  closeRate: CloseRate;
}

/**
 * Metas activas que se miden contra un objetivo. Las de `quotes`/`close_rate`
 * capturadas antes del cambio siguen en BD pero ya no cuentan: esos números
 * ahora se calculan solos (ver `EDITABLE_GOAL_METRICS`).
 */
async function listMeasuredGoals(): Promise<GoalRow[]> {
  const goals = await listGoals({ onlyActive: true });
  return goals.filter((g) => isEditableGoalMetric(g.metric));
}

const ZERO: ScopeAchievement = { quotes: 0, won: 0, amount: 0, quotesWon: 0 };

function scopeKey(s: GoalScope): string {
  return s.kind === "advisor" ? s.membershipId : s.kind; // uuid | "team" | "organic"
}

function achievedFor(metric: GoalMetric, a: ScopeAchievement): number {
  // Una sola definición para el avance en vivo y el snapshot (dashboard-metrics).
  return achievedForMetric(metric, a);
}

function toProgress(
  goal: GoalRow,
  achieved: number,
  thresholds: GoalThresholds,
  advisorName: string | null,
): GoalProgress {
  const target = Number(goal.target_value);
  const pct = computeGoalPct(achieved, target);
  return {
    goalId: goal.id,
    subject: goal.subject,
    advisorMembershipId: goal.advisor_membership_id,
    advisorName,
    metric: goal.metric,
    target,
    achieved,
    pct,
    zone: pct === null ? null : resolveGoalZone(pct, thresholds),
  };
}

/**
 * Avance para el admin: meta de equipo (scope "all" = totales de la org sin
 * filtrar por asesor) + las metas de cada vendedor (scope = su membership).
 * Solo computa el achievement de los scopes que realmente tienen meta activa.
 */
export async function loadAdminGoalProgress(
  organizationId: UUID,
): Promise<AdminGoalProgress> {
  const [org, goals, vendors] = await Promise.all([
    getOrganizationById(organizationId),
    listMeasuredGoals(),
    listRealVendorsForMapping(organizationId),
  ]);
  const thresholds = readGoalThresholds(org?.config ?? null);
  const period = resolveCurrentMonthPeriod();

  const nameById = new Map(vendors.map((v) => [v.id, v.profile.full_name]));
  const colorById = new Map(vendors.map((v) => [v.id, v.profile.color]));

  // El sujeto ya no se infiere de advisor_membership_id (0051): se lee.
  const teamGoals = goals.filter((g) => g.subject === "team");
  const organicGoals = goals.filter((g) => g.subject === "organic");
  const vendorGoals = goals.filter((g) => g.subject === "advisor");
  // Todo asesor entra, tenga meta o no: el % de cierre es automático y la
  // dirección lo quiere ver de cada vendedor sin tener que capturar nada.
  const vendorIds = Array.from(
    new Set([
      ...vendors.map((v) => v.id),
      ...vendorGoals.map((g) => g.advisor_membership_id as UUID),
    ]),
  );

  // Equipo y vendedores siempre (el % de cierre no depende de metas); la
  // orgánica solo si tiene meta — no tiene cotizaciones que medir.
  const scopes: GoalScope[] = [{ kind: "team" }];
  if (organicGoals.length > 0) scopes.push({ kind: "organic" });
  scopes.push(...vendorIds.map((id) => ({ kind: "advisor" as const, membershipId: id })));

  const achievements = await computeGoalAchievement(period, scopes);
  const achByScope = new Map<string, ScopeAchievement>();
  scopes.forEach((s, i) => achByScope.set(scopeKey(s), achievements[i]));

  const team = teamGoals.map((g) =>
    toProgress(g, achievedFor(g.metric, achByScope.get("team") ?? ZERO), thresholds, null),
  );
  const organic = organicGoals.map((g) =>
    toProgress(g, achievedFor(g.metric, achByScope.get("organic") ?? ZERO), thresholds, null),
  );

  const byVendor: VendorGoals[] = vendorIds
    .map((id) => {
      const ach = achByScope.get(id) ?? ZERO;
      const gs = vendorGoals
        .filter((g) => g.advisor_membership_id === id)
        .map((g) => toProgress(g, achievedFor(g.metric, ach), thresholds, nameById.get(id) ?? null));
      return {
        membershipId: id,
        name: nameById.get(id) ?? "Vendedor",
        color: colorById.get(id) ?? null,
        goals: gs,
        closeRate: closeRateOf(ach),
      };
    })
    // Un asesor sin meta ni cotizaciones en el mes no aporta nada que ver.
    .filter((v) => v.goals.length > 0 || v.closeRate.quotes > 0);

  return {
    thresholds,
    monthKey: currentMonthKey(),
    team,
    organic,
    byVendor,
    teamCloseRate: closeRateOf(achByScope.get("team") ?? ZERO),
  };
}

/**
 * % de cierre automático de un mes cualquiera (equipo + cada asesor con
 * cotizaciones). No hay snapshot que leer: por cohorte, el % de un mes cerrado
 * se recalcula de los datos — y es lo correcto, porque una cotización de julio
 * que se paga en septiembre SÍ mejora el cierre de julio.
 */
export async function loadCloseRatesForMonth(
  organizationId: UUID,
  monthKey: string,
): Promise<CloseRateRow[] | null> {
  const period: ResolvedPeriod | null = resolveMonthPeriod(monthKey);
  if (!period) return null;
  const vendors = await listRealVendorsForMapping(organizationId);
  const scopes: GoalScope[] = [
    { kind: "team" },
    ...vendors.map((v) => ({ kind: "advisor" as const, membershipId: v.id })),
  ];
  const achievements = await computeGoalAchievement(period, scopes);
  const rows: CloseRateRow[] = [
    { key: "team", subject: "team", name: "Equipo", color: null, closeRate: closeRateOf(achievements[0]) },
  ];
  vendors.forEach((v, i) => {
    const closeRate = closeRateOf(achievements[i + 1]);
    if (closeRate.quotes === 0) return;
    rows.push({
      key: v.id,
      subject: "advisor",
      name: v.profile.full_name,
      color: v.profile.color,
      closeRate,
    });
  });
  return rows;
}

/**
 * Avance para un vendedor: SOLO sus metas activas (filtradas por su
 * membership) y SOLO su scope. Nunca expone la meta de equipo ni la de otros
 * — el scoping vive acá, en la capa de datos, no en la UI.
 */
export async function loadVendorGoalProgress(
  organizationId: UUID,
  membershipId: UUID,
): Promise<VendorGoalProgress> {
  const [org, goals] = await Promise.all([
    getOrganizationById(organizationId),
    listMeasuredGoals(),
  ]);
  const thresholds = readGoalThresholds(org?.config ?? null);
  // Un vendedor ve SOLO sus metas: ni la de equipo ni la orgánica (que no es
  // de nadie en particular). El scoping vive aquí, no en la UI.
  const mine = goals.filter(
    (g) => g.subject === "advisor" && g.advisor_membership_id === membershipId,
  );
  // Sin membership (usuario sin cartera en la org) no hay nada que medir.
  if (!membershipId) {
    return { thresholds, monthKey: currentMonthKey(), goals: [], closeRate: closeRateOf(ZERO) };
  }
  // Se computa aunque no tenga metas: su % de cierre es automático.
  const period = resolveCurrentMonthPeriod();
  const [ach] = await computeGoalAchievement(period, [
    { kind: "advisor", membershipId },
  ]);
  const progress = mine.map((g) => toProgress(g, achievedFor(g.metric, ach), thresholds, null));
  return {
    thresholds,
    monthKey: currentMonthKey(),
    goals: progress,
    closeRate: closeRateOf(ach),
  };
}
