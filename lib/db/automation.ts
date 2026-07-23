import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import type {
  AutomationRuleRow,
  Funnel,
  RuleExecutionRow,
  RuleExecutionStatus,
  RuleTriggerType,
  Database,
  Json,
  UUID,
} from "@/lib/types/database";

type RuleInsert = Database["public"]["Tables"]["automation_rules"]["Insert"];
type RuleUpdate = Database["public"]["Tables"]["automation_rules"]["Update"];

export async function listRules(opts: {
  funnel?: Funnel;
  activeOnly?: boolean;
  triggerType?: RuleTriggerType;
} = {}): Promise<AutomationRuleRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("automation_rules")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });
  if (opts.funnel) query = query.eq("funnel", opts.funnel);
  if (opts.activeOnly) query = query.eq("is_active", true);
  if (opts.triggerType) query = query.eq("trigger_type", opts.triggerType);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

/**
 * Nombres de etapa referenciados por reglas de automatización ACTIVAS de
 * la org, con el label de la regla. Las reglas de tiempo resuelven su
 * etapa por `trigger_config.stage_name` (stage_aging) o
 * `restricted_to_stage` (no_activity) — renombrar/borrar esa etapa deja
 * la regla en `stage_not_found`. Usado por el detector de dependencia de
 * automatizaciones del panel de Etapas (Bloque A).
 */
export async function listActiveRuleStageNames(): Promise<
  { stageName: string; ruleLabel: string }[]
> {
  const rules = await listRules({ activeOnly: true });
  const refs: { stageName: string; ruleLabel: string }[] = [];
  for (const rule of rules) {
    const cfg = (rule.trigger_config ?? {}) as Record<string, unknown>;
    const stageName = cfg.stage_name ?? cfg.restricted_to_stage;
    if (typeof stageName === "string" && stageName.trim().length > 0) {
      refs.push({ stageName, ruleLabel: rule.name });
    }
  }
  return refs;
}

export async function getRuleById(id: UUID): Promise<AutomationRuleRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("automation_rules")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function createRule(
  input: Omit<RuleInsert, "organization_id">,
): Promise<AutomationRuleRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("automation_rules")
    .insert({ ...input, organization_id: organizationId })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function updateRule(
  id: UUID,
  patch: RuleUpdate,
): Promise<AutomationRuleRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("automation_rules")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function deleteRule(id: UUID): Promise<void> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { error } = await supabase
    .from("automation_rules")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (error) throw error;
}

/**
 * Idempotencia R4 (create_task): ¿ya hay una tarea ABIERTA
 * (pending|snoozed) generada por esta regla para este sujeto? Si la hay,
 * el motor NO crea otra (no duplicar mientras la anterior siga viva). La
 * procedencia se materializa en `tasks.created_by_rule_id` (0029).
 */
export async function hasOpenRuleTask(input: {
  ruleId: UUID;
  opportunityId?: UUID | null;
  contactId?: UUID | null;
}): Promise<boolean> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("created_by_rule_id", input.ruleId)
    .in("status", ["pending", "snoozed"]);
  if (input.opportunityId) query = query.eq("opportunity_id", input.opportunityId);
  else if (input.contactId) query = query.eq("contact_id", input.contactId);
  const { count, error } = await query;
  if (error) throw error;
  return (count ?? 0) > 0;
}

/**
 * Cooldown de re-insistencia (create_task): ¿esta regla COMPLETÓ una tarea
 * para este sujeto en/después de `sinceIso`? Si la hay, el motor NO recrea
 * todavía — espera a que vuelva a transcurrir el período propio de la regla
 * desde que se completó, para insistir a su propio ritmo (no en el tick
 * siguiente). `sinceIso` lo calcula el motor como `now - thresholdHours`.
 */
export async function hasRecentlyCompletedRuleTask(input: {
  ruleId: UUID;
  opportunityId?: UUID | null;
  contactId?: UUID | null;
  sinceIso: string;
}): Promise<boolean> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("created_by_rule_id", input.ruleId)
    .eq("status", "completed")
    .gte("completed_at", input.sinceIso);
  if (input.opportunityId) query = query.eq("opportunity_id", input.opportunityId);
  else if (input.contactId) query = query.eq("contact_id", input.contactId);
  const { count, error } = await query;
  if (error) throw error;
  return (count ?? 0) > 0;
}

/**
 * Idempotencia R4 (notify_*): ¿ya hay un aviso ABIERTO (pending|snoozed)
 * de esta regla para este sujeto? La procedencia vive en
 * `notifications.origin='rule'` + `origin_reference->>'rule_id'`.
 */
export async function hasOpenRuleNotification(input: {
  ruleId: UUID;
  opportunityId?: UUID | null;
  contactId?: UUID | null;
}): Promise<boolean> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("origin", "rule")
    .eq("origin_reference->>rule_id", input.ruleId)
    .in("status", ["pending", "snoozed"]);
  if (input.opportunityId) query = query.eq("opportunity_id", input.opportunityId);
  else if (input.contactId) query = query.eq("contact_id", input.contactId);
  const { count, error } = await query;
  if (error) throw error;
  return (count ?? 0) > 0;
}

/**
 * Cooldown de re-insistencia (notify_*): ¿esta regla CERRÓ un aviso
 * (completed|dismissed) para este sujeto en/después de `sinceIso`? Análogo
 * a `hasRecentlyCompletedRuleTask` pero para avisos — evita que la
 * campanita se llene de ruido repetido tras atender un aviso. Se ancla a
 * `updated_at` (en un aviso terminal = su momento de cierre; los avisos
 * cerrados ya no se vuelven a tocar) porque "dismissed" no estampa
 * `completed_at`. `sinceIso = now - thresholdHours` (período propio de la regla).
 */
export async function hasRecentlyClosedRuleNotification(input: {
  ruleId: UUID;
  opportunityId?: UUID | null;
  contactId?: UUID | null;
  sinceIso: string;
}): Promise<boolean> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("origin", "rule")
    .eq("origin_reference->>rule_id", input.ruleId)
    .in("status", ["completed", "dismissed"])
    .gte("updated_at", input.sinceIso);
  if (input.opportunityId) query = query.eq("opportunity_id", input.opportunityId);
  else if (input.contactId) query = query.eq("contact_id", input.contactId);
  const { count, error } = await query;
  if (error) throw error;
  return (count ?? 0) > 0;
}

/**
 * Circuit breaker: cuántas ejecuciones registró una regla desde `sinceIso`.
 * Si excede el umbral por tick/hora, el motor la desactiva con alerta.
 */
export async function countRuleExecutionsSince(
  ruleId: UUID,
  sinceIso: string,
): Promise<number> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { count, error } = await supabase
    .from("rule_executions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("rule_id", ruleId)
    .gte("executed_at", sinceIso);
  if (error) throw error;
  return count ?? 0;
}

export async function recordRuleExecution(input: {
  ruleId: UUID;
  opportunityId?: UUID | null;
  contactId?: UUID | null;
  status: RuleExecutionStatus;
  result?: Json;
}): Promise<RuleExecutionRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("rule_executions")
    .insert({
      organization_id: organizationId,
      rule_id: input.ruleId,
      opportunity_id: input.opportunityId ?? null,
      contact_id: input.contactId ?? null,
      status: input.status,
      result: input.result ?? {},
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function listRecentExecutions(opts: {
  ruleId?: UUID;
  limit?: number;
} = {}): Promise<RuleExecutionRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("rule_executions")
    .select("*")
    .eq("organization_id", organizationId)
    .order("executed_at", { ascending: false });
  if (opts.ruleId) query = query.eq("rule_id", opts.ruleId);
  query = query.limit(opts.limit ?? 50);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}
