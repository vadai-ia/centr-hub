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

export async function getTaskById(id: UUID): Promise<TaskRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function deleteTask(id: UUID): Promise<void> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { error } = await supabase
    .from("tasks")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (error) throw error;
}

/**
 * Lista todas las tareas de una oportunidad ordenadas por estado y due_at.
 * Pendientes primero (por due_at asc — más próximas arriba), después las
 * completadas/snoozeadas más recientes.
 */
export async function listTasksForOpportunity(
  opportunityId: UUID,
): Promise<TaskRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("opportunity_id", opportunityId)
    .order("status", { ascending: true })
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * Tareas ABIERTAS (pending|snoozed) de una oportunidad. Usado por la
 * cascada de reasignación: el contenido accionable pertenece a la opp, no
 * a la persona, así que al cambiar el asesor sus tareas abiertas siguen a
 * la opp. Las completadas (historial) NO entran.
 */
export async function listOpenTasksForOpportunity(
  opportunityId: UUID,
): Promise<TaskRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("opportunity_id", opportunityId)
    .in("status", ["pending", "snoozed"])
    .limit(5000);
  if (error) throw error;
  return data ?? [];
}

/** Avisos ABIERTOS (pending|snoozed) de una opp — análogo a las tareas. */
export async function listOpenNotificationsForOpportunity(
  opportunityId: UUID,
): Promise<NotificationRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("opportunity_id", opportunityId)
    .in("status", ["pending", "snoozed"])
    .limit(5000);
  if (error) throw error;
  return data ?? [];
}

/**
 * Cuenta tareas pendientes por oportunidad para un set de IDs.
 * Usado por el kanban (M6 polish) para mostrar contador en cards.
 * Si no hay opps, devuelve mapa vacío.
 */
export async function listPendingTaskCountsByOpportunity(
  opportunityIds: UUID[],
): Promise<Map<UUID, number>> {
  const result = new Map<UUID, number>();
  if (opportunityIds.length === 0) return result;
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("tasks")
    .select("opportunity_id")
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .in("opportunity_id", opportunityIds);
  if (error) throw error;
  for (const row of data ?? []) {
    const oppId = (row as { opportunity_id: UUID | null }).opportunity_id;
    if (!oppId) continue;
    result.set(oppId, (result.get(oppId) ?? 0) + 1);
  }
  return result;
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

export async function getNotificationById(id: UUID): Promise<NotificationRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
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

/**
 * Tareas snoozeadas cuyo `snoozed_until` ya venció (<= ahora). El cron
 * horario las reactiva a `pending` (CLAUDE.md: la reactivación es por
 * proceso programado, NO temporizador en cliente).
 */
export async function listDueSnoozedTasks(nowIso: string): Promise<TaskRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "snoozed")
    .not("snoozed_until", "is", null)
    .lte("snoozed_until", nowIso)
    .limit(5000);
  if (error) throw error;
  return data ?? [];
}

/** Avisos snoozeados vencidos — reactivados por el cron horario. */
export async function listDueSnoozedNotifications(
  nowIso: string,
): Promise<NotificationRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "snoozed")
    .not("snoozed_until", "is", null)
    .lte("snoozed_until", nowIso)
    .limit(5000);
  if (error) throw error;
  return data ?? [];
}

/**
 * user_ids de los admins/superadmins ACTIVOS de la org (tenant-scoped).
 * Destinatarios de `notify_admin`. `notifications.user_id` referencia
 * `user_profiles.id` = `memberships.user_id`.
 */
export async function listOrgAdminUserIds(): Promise<UUID[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .in("role", ["admin", "superadmin"]);
  if (error) throw error;
  return (data ?? []).map((r) => (r as { user_id: UUID }).user_id);
}

/**
 * user_id del membership (asesor). Destinatario de `notify_advisor`:
 * `opportunities.assigned_advisor_id` es un membership.id; el aviso se
 * dirige al user_id detrás. Devuelve null si el membership no existe.
 */
export async function getMembershipUserId(membershipId: UUID): Promise<UUID | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("id", membershipId)
    .maybeSingle();
  if (error) throw error;
  return (data?.user_id as UUID) ?? null;
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
