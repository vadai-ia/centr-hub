import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import type {
  ActivityRow,
  AuditLogRow,
  NotificationRow,
  TaskRow,
  Database,
  Json,
  UUID,
} from "@/lib/types/database";

type TaskInsert = Database["public"]["Tables"]["tasks"]["Insert"];
type TaskUpdate = Database["public"]["Tables"]["tasks"]["Update"];
type NotificationInsert = Database["public"]["Tables"]["notifications"]["Insert"];
type NotificationUpdate = Database["public"]["Tables"]["notifications"]["Update"];

// ============================================================
// activities — append-only timeline
// ============================================================

export async function recordActivity(input: {
  contactId?: UUID | null;
  opportunityId?: UUID | null;
  activityType: string;
  description: string;
  payload?: Json;
  triggeredByUserId?: UUID | null;
}): Promise<ActivityRow> {
  if (!input.contactId && !input.opportunityId) {
    throw new Error("recordActivity: contactId u opportunityId requeridos");
  }
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("activities")
    .insert({
      organization_id: organizationId,
      contact_id: input.contactId ?? null,
      opportunity_id: input.opportunityId ?? null,
      activity_type: input.activityType,
      description: input.description,
      payload: input.payload ?? {},
      triggered_by_user_id: input.triggeredByUserId ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function listActivities(opts: {
  contactId?: UUID;
  opportunityId?: UUID;
  limit?: number;
} = {}): Promise<ActivityRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("activities")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  if (opts.contactId) query = query.eq("contact_id", opts.contactId);
  if (opts.opportunityId) query = query.eq("opportunity_id", opts.opportunityId);
  query = query.limit(opts.limit ?? 100);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

// ============================================================
// tasks
// ============================================================

export async function createTask(
  input: Omit<TaskInsert, "organization_id">,
): Promise<TaskRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("tasks")
    .insert({ ...input, organization_id: organizationId })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function updateTask(id: UUID, patch: TaskUpdate): Promise<TaskRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("tasks")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function listTasksForUser(userId: UUID): Promise<TaskRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("assigned_user_id", userId)
    .order("due_at", { ascending: true, nullsFirst: false });
  if (error) throw error;
  return data ?? [];
}

// ============================================================
// notifications
// ============================================================

export async function createNotification(
  input: Omit<NotificationInsert, "organization_id">,
): Promise<NotificationRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("notifications")
    .insert({ ...input, organization_id: organizationId })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function updateNotification(
  id: UUID,
  patch: NotificationUpdate,
): Promise<NotificationRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("notifications")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function listNotificationsForUser(userId: UUID): Promise<NotificationRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .order("due_at", { ascending: true, nullsFirst: false });
  if (error) throw error;
  return data ?? [];
}

// ============================================================
// audit_log — append-only
// ============================================================

export async function recordAuditEvent(input: {
  actorUserId?: UUID | null;
  eventType: string;
  entityType?: string | null;
  entityId?: UUID | null;
  payload?: Json;
  ipAddress?: string | null;
}): Promise<AuditLogRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("audit_log")
    .insert({
      organization_id: organizationId,
      actor_user_id: input.actorUserId ?? null,
      event_type: input.eventType,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      payload: input.payload ?? {},
      ip_address: input.ipAddress ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function listAuditEvents(opts: {
  eventType?: string;
  limit?: number;
} = {}): Promise<AuditLogRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("audit_log")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  if (opts.eventType) query = query.eq("event_type", opts.eventType);
  query = query.limit(opts.limit ?? 100);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}
