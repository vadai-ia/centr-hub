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
