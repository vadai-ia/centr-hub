import "server-only";
import { requireTenantContext } from "@/lib/tenant/context";
import {
  listRules,
  updateRule,
  recordRuleExecution,
  hasOpenRuleTask,
  hasOpenRuleNotification,
  countRuleExecutionsSince,
} from "@/lib/db/automation";
import {
  createTask,
  createNotification,
  recordAuditEvent,
  updateTask,
  updateNotification,
  listDueSnoozedTasks,
  listDueSnoozedNotifications,
  listOrgAdminUserIds,
  getMembershipUserId,
} from "@/lib/db/operational";
import {
  listOpportunities,
  listStageEntryTimes,
} from "@/lib/db/opportunities";
import { listPipelineStages } from "@/lib/db/pipeline";
import { getTenantScopedClient } from "@/lib/db/client";
import { lastPlatformActivityForOpportunities } from "@/lib/services/activity-aggregation";
import {
  isTimeTrigger,
  thresholdHoursFromConfig,
  stageAgingConfigSchema,
  noActivityConfigSchema,
  contactNoActivityConfigSchema,
  ruleActionsSchema,
  ruleConditionsSchema,
  describeTrigger,
  type RuleAction,
  type RuleCondition,
} from "@/lib/automation/rule-config";
import { effectiveAmount } from "@/lib/format/money";
import type {
  AutomationRuleRow,
  OpportunityRow,
  PipelineStageRow,
  UUID,
} from "@/lib/types/database";

/**
 * Motor de reglas de automatización (M1v2 — implementa el stub de M1).
 *
 * Alcance V2 (decisión del operador):
 *   - SOLO triggers de tiempo, evaluados por el cron horario:
 *     stage_aging, no_activity, contact.no_activity.
 *   - SOLO acciones create_task / notify_advisor / notify_admin. Las
 *     acciones que modifican la oportunidad están prohibidas y se
 *     rechazan en ejecución (defensa en profundidad sobre 0029).
 *   - Idempotencia R4: no se duplica tarea/aviso mientras siga ABIERTO
 *     el generado por la misma regla para el mismo sujeto.
 *   - Circuit breaker: una regla que dispara demasiadas veces en una
 *     hora se desactiva con alerta al admin.
 *
 * DEBE invocarse dentro de `withTenantContext` (cron por-org).
 */

/** Tope de sujetos accionados por una regla en un solo tick. */
const MAX_SUBJECTS_PER_RULE_PER_TICK = 300;
/** Umbral del circuit breaker: ejecuciones de una regla en la última hora. */
const CIRCUIT_BREAKER_EXECUTIONS_PER_HOUR = 600;

export interface TickSummary {
  reactivatedTasks: number;
  reactivatedNotifications: number;
  rulesEvaluated: number;
  actionsApplied: number;
  rulesDisabled: number;
}

/**
 * Tick horario disparado desde el Inngest cron. Dos responsabilidades:
 *   1) Reactivar tareas/avisos snoozeados cuyo plazo venció.
 *   2) Evaluar las reglas activas con triggers de tiempo.
 */
export async function tickHourly(): Promise<TickSummary> {
  requireTenantContext();
  const nowIso = new Date().toISOString();

  const reactivated = await reactivateDueSnoozes(nowIso);
  const ruleResult = await evaluateTimeRules(nowIso);

  return {
    reactivatedTasks: reactivated.tasks,
    reactivatedNotifications: reactivated.notifications,
    rulesEvaluated: ruleResult.rulesEvaluated,
    actionsApplied: ruleResult.actionsApplied,
    rulesDisabled: ruleResult.rulesDisabled,
  };
}

// ------------------------------------------------------------
// Reactivación de snoozes vencidos
// ------------------------------------------------------------

async function reactivateDueSnoozes(
  nowIso: string,
): Promise<{ tasks: number; notifications: number }> {
  const [dueTasks, dueNotifs] = await Promise.all([
    listDueSnoozedTasks(nowIso),
    listDueSnoozedNotifications(nowIso),
  ]);
  for (const t of dueTasks) {
    await updateTask(t.id, { status: "pending", snoozed_until: null });
  }
  for (const n of dueNotifs) {
    await updateNotification(n.id, { status: "pending", snoozed_until: null });
  }
  return { tasks: dueTasks.length, notifications: dueNotifs.length };
}

// ------------------------------------------------------------
// Evaluación de reglas de tiempo
// ------------------------------------------------------------

async function evaluateTimeRules(
  nowIso: string,
): Promise<{ rulesEvaluated: number; actionsApplied: number; rulesDisabled: number }> {
  const rules = (await listRules({ activeOnly: true })).filter((r) =>
    isTimeTrigger(r.trigger_type),
  );
  const stages = await listPipelineStages();
  const adminUserIds = await listOrgAdminUserIds();
  const nowMs = Date.parse(nowIso);

  let actionsApplied = 0;
  let rulesDisabled = 0;
  let evaluated = 0;

  for (const rule of rules) {
    evaluated += 1;
    try {
      const subjects = await resolveCandidateSubjects(rule, stages, nowMs);
      if (subjects.length === 0) continue;

      // Circuit breaker: si esta regla ya disparó demasiado en la última
      // hora, o este tick produce demasiados sujetos, se desactiva.
      const sinceHourIso = new Date(nowMs - 3_600_000).toISOString();
      const recentExecutions = await countRuleExecutionsSince(rule.id, sinceHourIso);
      if (
        subjects.length > MAX_SUBJECTS_PER_RULE_PER_TICK ||
        recentExecutions > CIRCUIT_BREAKER_EXECUTIONS_PER_HOUR
      ) {
        await tripCircuitBreaker(rule, subjects.length, recentExecutions, adminUserIds);
        rulesDisabled += 1;
        continue;
      }

      const actions = parseActions(rule);
      for (const subject of subjects) {
        const applied = await applyRuleToSubject(rule, actions, subject, adminUserIds);
        actionsApplied += applied;
      }
    } catch (err) {
      await recordRuleExecution({
        ruleId: rule.id,
        status: "failed",
        result: { error: (err as Error)?.message ?? String(err) },
      });
    }
  }

  return { rulesEvaluated: evaluated, actionsApplied, rulesDisabled };
}

interface CandidateSubject {
  opportunityId?: UUID;
  contactId?: UUID;
  advisorMembershipId: UUID | null;
  amount: string | null;
  currency: string;
}

async function resolveCandidateSubjects(
  rule: AutomationRuleRow,
  stages: PipelineStageRow[],
  nowMs: number,
): Promise<CandidateSubject[]> {
  if (rule.trigger_type === "stage_aging") {
    return resolveStageAging(rule, stages, nowMs);
  }
  if (rule.trigger_type === "no_activity") {
    return resolveNoActivity(rule, stages, nowMs);
  }
  if (rule.trigger_type === "contact.no_activity") {
    return resolveContactNoActivity(rule, nowMs);
  }
  return [];
}

function oppSubject(opp: OpportunityRow): CandidateSubject {
  const amt = effectiveAmount(opp);
  return {
    opportunityId: opp.id,
    advisorMembershipId: opp.assigned_advisor_id,
    amount: amt.value,
    currency: opp.currency,
  };
}

async function resolveStageAging(
  rule: AutomationRuleRow,
  stages: PipelineStageRow[],
  nowMs: number,
): Promise<CandidateSubject[]> {
  const cfg = stageAgingConfigSchema.parse(rule.trigger_config);
  const stage = stages.find(
    (s) => s.funnel === rule.funnel && s.name === cfg.stage_name && s.is_active,
  );
  if (!stage) {
    await recordRuleExecution({
      ruleId: rule.id,
      status: "skipped",
      result: { reason: "stage_not_found", stage_name: cfg.stage_name },
    });
    return [];
  }
  const thresholdHours = thresholdHoursFromConfig(cfg)!;
  const opps = await listOpportunities({ funnel: rule.funnel, stageId: stage.id });
  const entryTimes = await listStageEntryTimes(
    opps.map((o) => o.id),
    stage.id,
  );
  const conditions = parseConditions(rule);
  const needActivity = conditions.some((c) => c.field === "no_activity_hours");
  const activityMap = needActivity
    ? await lastPlatformActivityForOpportunities(opps.map((o) => o.id))
    : null;

  const out: CandidateSubject[] = [];
  for (const opp of opps) {
    const enteredIso = entryTimes.get(opp.id) ?? opp.created_at;
    const ageHours = (nowMs - Date.parse(enteredIso)) / 3_600_000;
    if (ageHours < thresholdHours) continue;
    if (
      conditions.length > 0 &&
      !passesConditions(conditions, { nowMs, lastActivityIso: activityMap?.get(opp.id) ?? null })
    ) {
      continue;
    }
    out.push(oppSubject(opp));
  }
  return out;
}

async function resolveNoActivity(
  rule: AutomationRuleRow,
  stages: PipelineStageRow[],
  nowMs: number,
): Promise<CandidateSubject[]> {
  const cfg = noActivityConfigSchema.parse(rule.trigger_config);
  const thresholdHours = thresholdHoursFromConfig(cfg)!;
  const terminalStageIds = new Set(
    stages.filter((s) => s.is_won || s.is_lost).map((s) => s.id),
  );
  let restrictedStageId: UUID | undefined;
  if (cfg.restricted_to_stage) {
    const st = stages.find(
      (s) => s.funnel === rule.funnel && s.name === cfg.restricted_to_stage && s.is_active,
    );
    if (!st) {
      await recordRuleExecution({
        ruleId: rule.id,
        status: "skipped",
        result: { reason: "stage_not_found", stage_name: cfg.restricted_to_stage },
      });
      return [];
    }
    restrictedStageId = st.id;
  }

  const opps = await listOpportunities({
    funnel: rule.funnel,
    stageId: restrictedStageId,
  });
  const filtered = cfg.exclude_terminal_stages
    ? opps.filter((o) => !terminalStageIds.has(o.stage_id))
    : opps;
  const activityMap = await lastPlatformActivityForOpportunities(
    filtered.map((o) => o.id),
  );

  const out: CandidateSubject[] = [];
  for (const opp of filtered) {
    const lastIso = activityMap.get(opp.id) ?? opp.created_at;
    const idleHours = (nowMs - Date.parse(lastIso)) / 3_600_000;
    if (idleHours >= thresholdHours) out.push(oppSubject(opp));
  }
  return out;
}

async function resolveContactNoActivity(
  rule: AutomationRuleRow,
  nowMs: number,
): Promise<CandidateSubject[]> {
  const cfg = contactNoActivityConfigSchema.parse(rule.trigger_config);
  const thresholdHours = thresholdHoursFromConfig(cfg)!;

  // Contactos con asesor asignado, no archivados — los que un vendedor
  // sigue. (contact.no_activity no tiene semilla; capacidad latente.)
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("id, assigned_advisor_id")
    .eq("organization_id", organizationId)
    .not("assigned_advisor_id", "is", null)
    .eq("deleted_in_whaapy", false)
    .limit(5000);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: UUID; assigned_advisor_id: UUID | null }>;
  if (rows.length === 0) return [];

  const { lastPlatformActivityForContacts } = await import(
    "@/lib/services/activity-aggregation"
  );
  const activityMap = await lastPlatformActivityForContacts(rows.map((r) => r.id));

  const out: CandidateSubject[] = [];
  for (const c of rows) {
    const lastIso = activityMap.get(c.id);
    // Sin señal de actividad → candidato (nunca hubo actividad reciente).
    const idleHours = lastIso ? (nowMs - Date.parse(lastIso)) / 3_600_000 : Infinity;
    if (idleHours >= thresholdHours) {
      out.push({
        contactId: c.id,
        advisorMembershipId: c.assigned_advisor_id,
        amount: null,
        currency: "MXN",
      });
    }
  }
  return out;
}

// ------------------------------------------------------------
// Aplicación de acciones a un sujeto (idempotente R4)
// ------------------------------------------------------------

async function applyRuleToSubject(
  rule: AutomationRuleRow,
  actions: RuleAction[],
  subject: CandidateSubject,
  adminUserIds: UUID[],
): Promise<number> {
  const taken: string[] = [];
  const skipped: string[] = [];

  const hasCreateTask = actions.some((a) => a.type === "create_task");
  const hasNotify = actions.some(
    (a) => a.type === "notify_advisor" || a.type === "notify_admin",
  );
  const openTask = hasCreateTask
    ? await hasOpenRuleTask({
        ruleId: rule.id,
        opportunityId: subject.opportunityId ?? null,
        contactId: subject.contactId ?? null,
      })
    : false;
  const openNotif = hasNotify
    ? await hasOpenRuleNotification({
        ruleId: rule.id,
        opportunityId: subject.opportunityId ?? null,
        contactId: subject.contactId ?? null,
      })
    : false;

  for (const action of actions) {
    if (action.type === "create_task") {
      if (openTask) {
        skipped.push("create_task:already_open");
        continue;
      }
      const advisorUserId = subject.advisorMembershipId
        ? await getMembershipUserId(subject.advisorMembershipId)
        : null;
      if (!advisorUserId) {
        skipped.push("create_task:no_advisor");
        continue;
      }
      await createTask({
        contact_id: subject.contactId ?? null,
        opportunity_id: subject.opportunityId ?? null,
        assigned_user_id: advisorUserId,
        task_type: action.task_type,
        title: action.title,
        description: action.description ?? null,
        due_at: null,
        status: "pending",
        snoozed_until: null,
        completed_at: null,
        created_by_rule_id: rule.id,
      });
      taken.push("create_task");
    } else if (action.type === "notify_advisor") {
      if (openNotif) {
        skipped.push("notify_advisor:already_open");
        continue;
      }
      const advisorUserId = subject.advisorMembershipId
        ? await getMembershipUserId(subject.advisorMembershipId)
        : null;
      if (!advisorUserId) {
        skipped.push("notify_advisor:no_advisor");
        continue;
      }
      await createSubjectNotification(rule, subject, advisorUserId, action, "follow_up");
      taken.push("notify_advisor");
    } else if (action.type === "notify_admin") {
      if (openNotif) {
        skipped.push("notify_admin:already_open");
        continue;
      }
      for (const adminId of adminUserIds) {
        await createSubjectNotification(rule, subject, adminId, action, "alert");
      }
      if (adminUserIds.length > 0) taken.push("notify_admin");
      else skipped.push("notify_admin:no_admins");
    }
  }

  await recordRuleExecution({
    ruleId: rule.id,
    opportunityId: subject.opportunityId ?? null,
    contactId: subject.contactId ?? null,
    status: taken.length > 0 ? "success" : "skipped",
    result: { taken, skipped },
  });
  return taken.length;
}

async function createSubjectNotification(
  rule: AutomationRuleRow,
  subject: CandidateSubject,
  userId: UUID,
  action: Extract<RuleAction, { type: "notify_advisor" | "notify_admin" }>,
  defaultType: string,
): Promise<void> {
  await createNotification({
    user_id: userId,
    notification_type: action.type === "notify_admin" ? "alert" : defaultType,
    origin: "rule",
    origin_reference: { rule_id: rule.id, trigger_type: rule.trigger_type },
    opportunity_id: subject.opportunityId ?? null,
    contact_id: subject.contactId ?? null,
    title: action.title ?? rule.name,
    message: action.message ?? describeTrigger(rule.trigger_type, rule.trigger_config),
    amount_at_stake: subject.amount,
    due_at: null,
    status: "pending",
    snoozed_until: null,
    completed_at: null,
    schema_version: "v1",
  });
}

async function tripCircuitBreaker(
  rule: AutomationRuleRow,
  subjectCount: number,
  recentExecutions: number,
  adminUserIds: UUID[],
): Promise<void> {
  await updateRule(rule.id, { is_active: false });
  await recordAuditEvent({
    actorUserId: null,
    eventType: "rule_circuit_breaker_tripped",
    entityType: "automation_rule",
    entityId: rule.id,
    payload: {
      rule_name: rule.name,
      subject_count: subjectCount,
      recent_executions: recentExecutions,
    },
  });
  for (const adminId of adminUserIds) {
    await createNotification({
      user_id: adminId,
      notification_type: "alert",
      origin: "system",
      origin_reference: { rule_id: rule.id, reason: "circuit_breaker" },
      opportunity_id: null,
      contact_id: null,
      title: "Regla desactivada automáticamente",
      message: `La regla "${rule.name}" disparó demasiadas veces y se desactivó por seguridad. Revísala en Administración → Reglas.`,
      amount_at_stake: null,
      due_at: null,
      status: "pending",
      snoozed_until: null,
      completed_at: null,
      schema_version: "v1",
    });
  }
}

// ------------------------------------------------------------
// Parsing defensivo de actions/conditions
// ------------------------------------------------------------

/**
 * Acciones válidas y PERMITIDAS en V2. Si una regla trae una acción
 * prohibida (move_to_stage, add_tag, assign_*), Zod la descarta de la
 * union — `ruleActionsSchema` falla y devolvemos []. Las acciones se
 * filtran defensivamente aunque 0029 ya las haya depurado de la data.
 */
function parseActions(rule: AutomationRuleRow): RuleAction[] {
  const parsed = ruleActionsSchema.safeParse(rule.actions);
  if (!parsed.success) {
    // Intenta rescatar solo las permitidas (regla con acción prohibida
    // embebida): filtra elemento por elemento.
    if (Array.isArray(rule.actions)) {
      const salvaged: RuleAction[] = [];
      for (const el of rule.actions) {
        const one = ruleActionsSchema.safeParse([el]);
        if (one.success) salvaged.push(one.data[0]);
      }
      return salvaged;
    }
    return [];
  }
  return parsed.data;
}

function parseConditions(rule: AutomationRuleRow): RuleCondition[] {
  const parsed = ruleConditionsSchema.safeParse(rule.conditions);
  return parsed.success ? parsed.data : [];
}

function passesConditions(
  conditions: RuleCondition[],
  ctx: { nowMs: number; lastActivityIso: string | null },
): boolean {
  for (const cond of conditions) {
    if (cond.field === "no_activity_hours") {
      const hours = ctx.lastActivityIso
        ? (ctx.nowMs - Date.parse(ctx.lastActivityIso)) / 3_600_000
        : Number.MAX_SAFE_INTEGER;
      if (!compareOp(hours, cond.op, cond.value)) return false;
    }
    // Campos desconocidos se ignoran (no bloquean) — forward-compatible.
  }
  return true;
}

function compareOp(actual: number, op: "gte" | "lte" | "eq", value: number): boolean {
  if (op === "gte") return actual >= value;
  if (op === "lte") return actual <= value;
  return actual === value;
}
