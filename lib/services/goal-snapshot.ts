import "server-only";
import {
  computeGoalAchievement,
  type Scope,
  type ScopeAchievement,
} from "@/lib/services/dashboard-metrics";
import {
  insertGoalResults,
  listGoalResultsForMonth,
  listGoals,
} from "@/lib/db/metas";
import { computeGoalPct } from "@/lib/metas/semaphore";
import type { GoalMetric } from "@/lib/metas/schema";
import type { ResolvedPeriod } from "@/lib/time/period";
import type { Database } from "@/lib/types/database";

/** Fila que se inserta en goal_results (sin organization_id, lo pone la capa db). */
export type SnapshotRow = Omit<
  Database["public"]["Tables"]["goal_results"]["Insert"],
  "organization_id"
>;

/**
 * Snapshot mensual del cumplimiento de metas (M2v2 — Bloque 6). Al cerrar el
 * mes, congela en `goal_results` el resultado de cada meta ACTIVA (target,
 * logrado, pct) reusando las MISMAS fuentes del Dashboard
 * (`computeGoalAchievement`). El registro es self-contained → sobrevive a
 * cambios o borrado de la meta.
 *
 * Debe correr dentro de `withTenantContext(orgId, ...)` (las queries son
 * tenant-scoped). Idempotente: si ya hay snapshots de ese mes, no escribe
 * nada (los índices únicos parciales de 0031 son la red de respaldo).
 */

const ZERO: ScopeAchievement = { quotes: 0, won: 0, amount: 0 };

function scopeKey(s: Scope): string {
  return s === null ? "__none__" : String(s);
}

function achievedFor(metric: GoalMetric, a: ScopeAchievement): number {
  return metric === "quotes" ? a.quotes : metric === "won" ? a.won : a.amount;
}

export interface SnapshotResult {
  written: number;
  skipped: boolean;
  /** true si ya había snapshots de ese mes (informa al dry-run). */
  alreadyExists: boolean;
  /** Filas calculadas (en dry-run, lo que se escribiría). */
  rows: SnapshotRow[];
}

export async function snapshotMonthlyGoals(input: {
  period: ResolvedPeriod;
  periodMonth: string; // yyyy-MM-dd (primer día del mes, MX)
  /** Calcula pero NO escribe; devuelve las filas que se insertarían. */
  dryRun?: boolean;
}): Promise<SnapshotResult> {
  const dryRun = input.dryRun ?? false;

  // Idempotencia: si ya se snapshoteó este mes, no repetir. En dry-run NO se
  // corta acá — se calcula igual para mostrar los valores (pero se reporta
  // alreadyExists para no engañar).
  const existing = await listGoalResultsForMonth(input.periodMonth);
  const alreadyExists = existing.length > 0;
  if (alreadyExists && !dryRun) {
    return { written: 0, skipped: true, alreadyExists, rows: [] };
  }

  const goals = await listGoals({ onlyActive: true });
  if (goals.length === 0) {
    return { written: 0, skipped: false, alreadyExists, rows: [] };
  }

  const teamGoals = goals.filter((g) => g.advisor_membership_id === null);
  const vendorIds = Array.from(
    new Set(goals.filter((g) => g.advisor_membership_id !== null).map((g) => g.advisor_membership_id as string)),
  );
  const scopes: Scope[] = [];
  if (teamGoals.length > 0) scopes.push("all");
  scopes.push(...vendorIds);

  const achievements = await computeGoalAchievement(input.period, scopes);
  const achByScope = new Map<string, ScopeAchievement>();
  scopes.forEach((s, i) => achByScope.set(scopeKey(s), achievements[i]));

  const rows: SnapshotRow[] = goals.map((g) => {
    const scope: Scope = g.advisor_membership_id === null ? "all" : g.advisor_membership_id;
    const ach = achByScope.get(scopeKey(scope)) ?? ZERO;
    const achieved = achievedFor(g.metric, ach);
    const target = Number(g.target_value);
    const pct = computeGoalPct(achieved, target) ?? 0;
    return {
      goal_id: g.id,
      advisor_membership_id: g.advisor_membership_id,
      metric: g.metric,
      period_month: input.periodMonth,
      target_value: String(target),
      achieved_value: String(achieved),
      pct: pct.toFixed(2),
    };
  });

  if (dryRun) {
    return { written: 0, skipped: false, alreadyExists, rows };
  }

  await insertGoalResults(rows);
  return { written: rows.length, skipped: false, alreadyExists, rows };
}
