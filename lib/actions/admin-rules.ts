"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenantContext } from "@/lib/tenant/context";
import { resolveAdminContext } from "@/lib/auth/admin-guard";
import {
  listRules,
  createRule,
  updateRule,
  deleteRule,
  getRuleById,
} from "@/lib/db/automation";
import { listPipelineStages } from "@/lib/db/pipeline";
import { recordAuditEvent } from "@/lib/db/operational";
import {
  TIME_TRIGGER_TYPES,
  ruleActionsSchema,
  ruleConditionsSchema,
  stageAgingConfigSchema,
  noActivityConfigSchema,
  contactNoActivityConfigSchema,
} from "@/lib/automation/rule-config";
import type { AutomationRuleRow, PipelineStageRow } from "@/lib/types/database";

/**
 * Server actions de administración del Motor de Reglas (M1v2 — Bloque A3).
 * Solo admin/superadmin. El admin crea/edita/elimina reglas, activa o
 * desactiva las preconfiguradas. Alcance V2: solo triggers de tiempo y
 * acciones create_task / notify_advisor / notify_admin (validado abajo;
 * el motor las rechaza de nuevo en ejecución).
 */

export type RulesActionResult =
  | { ok: true; rules: AutomationRuleRow[] }
  | { ok: false; message: string };

export type RulesLoadResult =
  | { ok: true; rules: AutomationRuleRow[]; stages: PipelineStageRow[] }
  | { ok: false; message: string };

const triggerConfigByType = {
  stage_aging: stageAgingConfigSchema,
  no_activity: noActivityConfigSchema,
  "contact.no_activity": contactNoActivityConfigSchema,
} as const;

const baseRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  funnel: z.enum(["venta", "post_venta"]),
  trigger_type: z.enum(TIME_TRIGGER_TYPES),
  trigger_config: z.unknown(),
  conditions: z.unknown().optional(),
  actions: z.unknown(),
});

/**
 * Valida y normaliza el payload de una regla. Devuelve los JSONB ya
 * saneados (trigger_config por tipo, conditions, actions solo permitidas)
 * o un error legible.
 */
function buildRulePayload(raw: unknown):
  | {
      ok: true;
      data: {
        name: string;
        description: string | null;
        funnel: "venta" | "post_venta";
        trigger_type: (typeof TIME_TRIGGER_TYPES)[number];
        trigger_config: Record<string, unknown>;
        conditions: unknown[];
        actions: unknown[];
      };
    }
  | { ok: false; message: string } {
  const parsed = baseRuleSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos de la regla inválidos." };

  const cfgSchema = triggerConfigByType[parsed.data.trigger_type];
  const cfg = cfgSchema.safeParse(parsed.data.trigger_config);
  if (!cfg.success) {
    return { ok: false, message: "Configuración del disparador inválida." };
  }

  const actions = ruleActionsSchema.safeParse(parsed.data.actions);
  if (!actions.success) {
    return {
      ok: false,
      message:
        "Acciones inválidas. En V2 una regla solo puede crear tareas y avisar (no mover de etapa ni reasignar).",
    };
  }

  const conditions = parsed.data.conditions
    ? ruleConditionsSchema.safeParse(parsed.data.conditions)
    : ({ success: true, data: [] } as const);
  if (!conditions.success) {
    return { ok: false, message: "Condiciones inválidas." };
  }

  return {
    ok: true,
    data: {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      funnel: parsed.data.funnel,
      trigger_type: parsed.data.trigger_type,
      trigger_config: cfg.data as Record<string, unknown>,
      conditions: conditions.data as unknown[],
      actions: actions.data as unknown[],
    },
  };
}

export async function loadAdminRules(): Promise<RulesLoadResult> {
  const admin = await resolveAdminContext();
  if (!admin.ok) return admin;
  return withTenantContext(
    admin.ctx.orgId,
    async () => ({
      ok: true as const,
      rules: await listRules(),
      stages: await listPipelineStages(),
    }),
    { source: "user_session" },
  );
}

export async function createRuleAction(raw: unknown): Promise<RulesActionResult> {
  const admin = await resolveAdminContext();
  if (!admin.ok) return admin;
  const built = buildRulePayload(raw);
  if (!built.ok) return built;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const created = await createRule({
        funnel: built.data.funnel,
        name: built.data.name,
        description: built.data.description,
        is_active: true,
        is_template: false,
        trigger_type: built.data.trigger_type,
        trigger_config: built.data.trigger_config as never,
        conditions: built.data.conditions as never,
        actions: built.data.actions as never,
        schema_version: "v1",
        created_by_user_id: admin.ctx.userId,
      });
      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "rule_created",
        entityType: "automation_rule",
        entityId: created.id,
        payload: { name: created.name, trigger_type: created.trigger_type },
      });
      revalidatePath("/admin/reglas");
      return { ok: true as const, rules: await listRules() };
    },
    { source: "user_session" },
  );
}

const updateSchema = baseRuleSchema.extend({ id: z.string().uuid() });

export async function updateRuleAction(raw: unknown): Promise<RulesActionResult> {
  const admin = await resolveAdminContext();
  if (!admin.ok) return admin;
  const idParse = updateSchema.safeParse(raw);
  if (!idParse.success) return { ok: false, message: "Datos de la regla inválidos." };
  const built = buildRulePayload(raw);
  if (!built.ok) return built;

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const existing = await getRuleById(idParse.data.id);
      if (!existing) return { ok: false as const, message: "La regla no existe." };
      await updateRule(idParse.data.id, {
        funnel: built.data.funnel,
        name: built.data.name,
        description: built.data.description,
        trigger_type: built.data.trigger_type,
        trigger_config: built.data.trigger_config as never,
        conditions: built.data.conditions as never,
        actions: built.data.actions as never,
      });
      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "rule_updated",
        entityType: "automation_rule",
        entityId: idParse.data.id,
        payload: { name: built.data.name },
      });
      revalidatePath("/admin/reglas");
      return { ok: true as const, rules: await listRules() };
    },
    { source: "user_session" },
  );
}

const toggleSchema = z.object({ id: z.string().uuid(), is_active: z.boolean() });

export async function toggleRuleAction(raw: unknown): Promise<RulesActionResult> {
  const admin = await resolveAdminContext();
  if (!admin.ok) return admin;
  const parsed = toggleSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos inválidos." };

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const existing = await getRuleById(parsed.data.id);
      if (!existing) return { ok: false as const, message: "La regla no existe." };
      await updateRule(parsed.data.id, { is_active: parsed.data.is_active });
      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "rule_toggled",
        entityType: "automation_rule",
        entityId: parsed.data.id,
        payload: { is_active: parsed.data.is_active },
      });
      revalidatePath("/admin/reglas");
      return { ok: true as const, rules: await listRules() };
    },
    { source: "user_session" },
  );
}

const deleteSchema = z.object({ id: z.string().uuid() });

export async function deleteRuleAction(raw: unknown): Promise<RulesActionResult> {
  const admin = await resolveAdminContext();
  if (!admin.ok) return admin;
  const parsed = deleteSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Identificador inválido." };

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const existing = await getRuleById(parsed.data.id);
      if (!existing) return { ok: false as const, message: "La regla no existe." };
      await deleteRule(parsed.data.id);
      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "rule_deleted",
        entityType: "automation_rule",
        entityId: parsed.data.id,
        payload: { name: existing.name },
      });
      revalidatePath("/admin/reglas");
      return { ok: true as const, rules: await listRules() };
    },
    { source: "user_session" },
  );
}
