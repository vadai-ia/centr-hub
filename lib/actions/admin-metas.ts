"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { resolveAdminContext } from "@/lib/auth/admin-guard";
import { withTenantContext } from "@/lib/tenant/context";
import {
  createGoal,
  deleteGoal,
  getGoalFor,
  listGoalResults,
  listGoals,
  updateGoal,
} from "@/lib/db/metas";
import { getOrganizationById, updateOrganization } from "@/lib/db/organizations";
import { listRealVendorsForMapping } from "@/lib/db/users";
import { recordAuditEvent } from "@/lib/db/operational";
import {
  goalInputSchema,
  goalThresholdsInputSchema,
  isCountMetric,
  type GoalMetric,
} from "@/lib/metas/schema";
import {
  goalThresholdsToConfig,
  readGoalThresholds,
} from "@/lib/services/metas-config";
import { sanitizeGoalThresholds, type GoalThresholds } from "@/lib/metas/semaphore";
import { monthLabel } from "@/lib/time/period";
import type { GoalRow, Json, UUID } from "@/lib/types/database";

/**
 * Server actions de la pestaña admin de Metas (M2v2 — Bloque 3). Solo
 * admin/superadmin (guard `resolveAdminContext`). Cada mutación corre dentro
 * de `withTenantContext` + audita + revalida Dashboard y Mi Día (consumen el
 * avance). La configuración de metas/umbrales solo la toca el admin.
 */

// ── Vistas que consume la pantalla ──────────────────────────────────────
export interface MetaGoalView {
  id: UUID;
  advisorMembershipId: UUID | null; // null = meta de equipo
  metric: GoalMetric;
  targetValue: number;
  isActive: boolean;
}
export interface MetaVendorView {
  membershipId: UUID;
  name: string;
  color: string | null;
}
export interface MetaHistoryRow {
  id: UUID;
  periodMonth: string; // yyyy-MM-dd
  monthKey: string; // yyyy-MM
  monthLabel: string; // "may 2026"
  advisorMembershipId: UUID | null;
  advisorName: string; // "Equipo" o el nombre del vendedor
  metric: GoalMetric;
  target: number;
  achieved: number;
  pct: number;
}
export interface AdminMetasData {
  vendors: MetaVendorView[];
  goals: MetaGoalView[];
  thresholds: GoalThresholds;
  history: MetaHistoryRow[];
}

export type LoadAdminMetasResult =
  | { ok: true; data: AdminMetasData }
  | { ok: false; message: string };
export type GoalsMutationResult =
  | { ok: true; goals: MetaGoalView[] }
  | { ok: false; message: string };
export type ThresholdsMutationResult =
  | { ok: true; thresholds: GoalThresholds }
  | { ok: false; message: string };

function toGoalView(g: GoalRow): MetaGoalView {
  return {
    id: g.id,
    advisorMembershipId: g.advisor_membership_id,
    metric: g.metric,
    targetValue: Number(g.target_value),
    isActive: g.is_active,
  };
}

/** Revalida las superficies que muestran avance de metas. */
function revalidateMetasSurfaces(): void {
  revalidatePath("/admin/metas");
  revalidatePath("/dashboard");
  revalidatePath("/mi-dia");
}

// ── Carga inicial ───────────────────────────────────────────────────────
export async function loadAdminMetas(): Promise<LoadAdminMetasResult> {
  const admin = await resolveAdminContext("admin-metas");
  if (!admin.ok) return admin;
  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const [org, goals, vendors, history] = await Promise.all([
        getOrganizationById(admin.ctx.orgId),
        listGoals(),
        listRealVendorsForMapping(admin.ctx.orgId),
        listGoalResults({ limit: 240 }),
      ]);
      const thresholds = readGoalThresholds(org?.config ?? null);
      const nameById = new Map(vendors.map((v) => [v.id, v.profile.full_name]));

      const historyRows: MetaHistoryRow[] = history.map((r) => {
        const monthKey = r.period_month.slice(0, 7);
        return {
          id: r.id,
          periodMonth: r.period_month,
          monthKey,
          monthLabel: monthLabel(monthKey),
          advisorMembershipId: r.advisor_membership_id,
          advisorName:
            r.advisor_membership_id === null
              ? "Equipo"
              : nameById.get(r.advisor_membership_id) ?? "Vendedor",
          metric: r.metric,
          target: Number(r.target_value),
          achieved: Number(r.achieved_value),
          pct: Number(r.pct),
        };
      });

      return {
        ok: true as const,
        data: {
          vendors: vendors.map((v) => ({
            membershipId: v.id,
            name: v.profile.full_name,
            color: v.profile.color,
          })),
          goals: goals.map(toGoalView),
          thresholds,
          history: historyRows,
        },
      };
    },
    { source: "user_session" },
  );
}

// ── Crear / actualizar una meta (upsert por sujeto + métrica) ───────────
export async function upsertGoalAction(raw: unknown): Promise<GoalsMutationResult> {
  const parsed = goalInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Datos inválidos." };
  }
  const input = parsed.data;
  const admin = await resolveAdminContext("admin-metas");
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      // Si es meta de vendedor, validar que el membership sea un vendedor real.
      if (input.advisorMembershipId !== null) {
        const vendors = await listRealVendorsForMapping(admin.ctx.orgId);
        if (!vendors.some((v) => v.id === input.advisorMembershipId)) {
          return { ok: false as const, message: "Vendedor inválido." };
        }
      }
      // Conteos se guardan como entero; monto admite decimales.
      const target = isCountMetric(input.metric)
        ? Math.round(input.targetValue)
        : input.targetValue;

      const existing = await getGoalFor(input.advisorMembershipId, input.metric);
      if (existing) {
        await updateGoal(existing.id, {
          target_value: String(target),
          is_active: input.isActive,
        });
      } else {
        await createGoal({
          advisor_membership_id: input.advisorMembershipId,
          metric: input.metric,
          target_value: String(target),
          is_active: input.isActive,
          created_by_user_id: admin.ctx.userId,
        });
      }

      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "goal_upserted",
        entityType: "goal",
        entityId: existing?.id ?? null,
        payload: {
          advisor_membership_id: input.advisorMembershipId,
          metric: input.metric,
          target_value: target,
          is_active: input.isActive,
        },
      });

      revalidateMetasSurfaces();
      const goals = await listGoals();
      return { ok: true as const, goals: goals.map(toGoalView) };
    },
    { source: "user_session" },
  );
}

const goalActiveSchema = z.object({ id: z.string().uuid(), isActive: z.boolean() });

export async function setGoalActiveAction(raw: unknown): Promise<GoalsMutationResult> {
  const parsed = goalActiveSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos inválidos." };
  const admin = await resolveAdminContext("admin-metas");
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      await updateGoal(parsed.data.id, { is_active: parsed.data.isActive });
      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "goal_active_changed",
        entityType: "goal",
        entityId: parsed.data.id,
        payload: { is_active: parsed.data.isActive },
      });
      revalidateMetasSurfaces();
      const goals = await listGoals();
      return { ok: true as const, goals: goals.map(toGoalView) };
    },
    { source: "user_session" },
  );
}

const goalDeleteSchema = z.object({ id: z.string().uuid() });

export async function deleteGoalAction(raw: unknown): Promise<GoalsMutationResult> {
  const parsed = goalDeleteSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Identificador inválido." };
  const admin = await resolveAdminContext("admin-metas");
  if (!admin.ok) return admin;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      await deleteGoal(parsed.data.id);
      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "goal_deleted",
        entityType: "goal",
        entityId: parsed.data.id,
        payload: {},
      });
      revalidateMetasSurfaces();
      const goals = await listGoals();
      return { ok: true as const, goals: goals.map(toGoalView) };
    },
    { source: "user_session" },
  );
}

// ── Guardar umbrales del semáforo (config.metas) ────────────────────────
export async function saveThresholdsAction(
  raw: unknown,
): Promise<ThresholdsMutationResult> {
  const parsed = goalThresholdsInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Umbrales inválidos." };
  const admin = await resolveAdminContext("admin-metas");
  if (!admin.ok) return admin;

  const thresholds = sanitizeGoalThresholds(parsed.data);

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const org = await getOrganizationById(admin.ctx.orgId);
      if (!org) return { ok: false as const, message: "Organización no encontrada." };

      const baseConfig: Record<string, Json> =
        org.config && typeof org.config === "object" && !Array.isArray(org.config)
          ? { ...(org.config as Record<string, Json>) }
          : {};
      const baseMetas: Record<string, Json> =
        baseConfig.metas &&
        typeof baseConfig.metas === "object" &&
        !Array.isArray(baseConfig.metas)
          ? { ...(baseConfig.metas as Record<string, Json>) }
          : {};
      const serialized = goalThresholdsToConfig(thresholds);
      baseMetas.green_pct = serialized.green_pct;
      baseMetas.yellow_pct = serialized.yellow_pct;
      baseConfig.metas = baseMetas as Json;

      await updateOrganization(admin.ctx.orgId, { config: baseConfig as Json });
      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "goal_thresholds_changed",
        entityType: "organization",
        entityId: admin.ctx.orgId,
        payload: serialized,
      });

      revalidateMetasSurfaces();
      return { ok: true as const, thresholds };
    },
    { source: "user_session" },
  );
}
