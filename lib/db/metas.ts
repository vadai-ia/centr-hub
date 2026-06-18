import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import type {
  Database,
  GoalMetricDb,
  GoalResultRow,
  GoalRow,
  UUID,
} from "@/lib/types/database";

/**
 * Capa de datos de Metas (M2v2 — Bloque 1). Tenant-scoped: todas las queries
 * pasan por `getTenantScopedClient()` (RLS + filtro explícito por org). El
 * cómputo de avance (reusando los KPIs del Dashboard) y el snapshot mensual
 * viven en la capa de servicio (Bloques 2 y 6); aquí solo CRUD/lecturas.
 */

type GoalInsert = Database["public"]["Tables"]["goals"]["Insert"];
type GoalUpdate = Database["public"]["Tables"]["goals"]["Update"];
type GoalResultInsert = Database["public"]["Tables"]["goal_results"]["Insert"];

// ============================================================
// goals
// ============================================================

/** Todas las metas de la org (activas e inactivas), para la pantalla admin. */
export async function listGoals(opts: { onlyActive?: boolean } = {}): Promise<GoalRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("goals")
    .select("*")
    .eq("organization_id", organizationId);
  if (opts.onlyActive) query = query.eq("is_active", true);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

/**
 * Meta de un sujeto + métrica concretos. `advisorMembershipId === null`
 * resuelve la meta GENERAL de equipo. Devuelve null si no existe.
 */
export async function getGoalFor(
  advisorMembershipId: UUID | null,
  metric: GoalMetricDb,
): Promise<GoalRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("goals")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("metric", metric);
  query =
    advisorMembershipId === null
      ? query.is("advisor_membership_id", null)
      : query.eq("advisor_membership_id", advisorMembershipId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function createGoal(
  input: Omit<GoalInsert, "organization_id">,
): Promise<GoalRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("goals")
    .insert({ ...input, organization_id: organizationId })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function updateGoal(id: UUID, patch: GoalUpdate): Promise<GoalRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("goals")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function deleteGoal(id: UUID): Promise<void> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { error } = await supabase
    .from("goals")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (error) throw error;
}

// ============================================================
// goal_results (histórico mensual — append-only)
// ============================================================

/**
 * Histórico de resultados, más reciente primero. `opts.months` acota a los
 * últimos N meses distintos (para la vista del admin). Sin opts → todo.
 */
export async function listGoalResults(opts: { limit?: number } = {}): Promise<GoalResultRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("goal_results")
    .select("*")
    .eq("organization_id", organizationId)
    .order("period_month", { ascending: false });
  if (opts.limit) query = query.limit(opts.limit);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

/** Snapshots ya escritos para un mes concreto (para idempotencia del cron). */
export async function listGoalResultsForMonth(
  periodMonth: string,
): Promise<GoalResultRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("goal_results")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("period_month", periodMonth);
  if (error) throw error;
  return data ?? [];
}

/**
 * Inserta los snapshots de un mes. El cron (Bloque 6) garantiza idempotencia
 * (no llama si ya existen filas del mes); los índices únicos parciales son la
 * última red contra duplicados por (org, sujeto, métrica, mes).
 */
export async function insertGoalResults(
  rows: Omit<GoalResultInsert, "organization_id">[],
): Promise<void> {
  if (rows.length === 0) return;
  const { supabase, organizationId } = getTenantScopedClient();
  const { error } = await supabase
    .from("goal_results")
    .insert(rows.map((r) => ({ ...r, organization_id: organizationId })));
  if (error) throw error;
}
