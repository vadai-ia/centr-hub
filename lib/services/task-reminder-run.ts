import "server-only";
import { TASK_REMINDER_NOTIFICATION_TYPE, TASK_REMINDER_REINSIST_HOURS } from "@/lib/constants";
import { createNotification } from "@/lib/db/operational";
import {
  closeTaskReminders,
  listPendingTasksDueBy,
  listRelevantTaskReminders,
} from "@/lib/db/task-reminders";
import {
  decideTaskReminders,
  type ExistingReminder,
  type ReminderTask,
  type SkipReason,
} from "@/lib/services/task-reminders";
import { todayBoundsUtc } from "@/lib/time/period";
import type { Json, NotificationRow, UUID } from "@/lib/types/database";

/**
 * Ejecución de los recordatorios de tareas en UNA organización. La decisión
 * vive en `task-reminders.ts` (pura); aquí solo está la lectura, la escritura
 * y el resumen.
 */

export interface TaskReminderRunSummary {
  evaluated: number;
  created: number;
  closed: number;
  skipped: Partial<Record<SkipReason, number>>;
}

/** `origin_reference.task_id` — el único vínculo aviso ↔ tarea. */
function taskIdOf(row: NotificationRow): UUID | null {
  const ref = row.origin_reference;
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
  const id = (ref as Record<string, unknown>).task_id;
  return typeof id === "string" && id.length > 0 ? (id as UUID) : null;
}

export async function runTaskReminders(input: {
  zone: string;
  firstHour: number;
  nowISO?: string;
}): Promise<TaskReminderRunSummary> {
  const nowISO = input.nowISO ?? new Date().toISOString();
  // El corte superior es el fin de HOY en la zona de la organización: una
  // tarea que vence mañana no se trae siquiera.
  const { endUtc } = todayBoundsUtc(input.zone);

  const sinceISO = new Date(
    new Date(nowISO).getTime() - TASK_REMINDER_REINSIST_HOURS * 2 * 3_600_000,
  ).toISOString();

  const [taskRows, reminderRows] = await Promise.all([
    listPendingTasksDueBy(endUtc),
    listRelevantTaskReminders(sinceISO),
  ]);

  const tasks: ReminderTask[] = taskRows.map((t) => ({
    id: t.id,
    assignedUserId: t.assigned_user_id,
    title: t.title,
    dueAt: t.due_at,
    status: t.status,
    opportunityId: t.opportunity_id,
    contactId: t.contact_id,
  }));

  const reminders: ExistingReminder[] = [];
  for (const row of reminderRows) {
    const taskId = taskIdOf(row);
    if (!taskId) continue;
    reminders.push({
      id: row.id,
      taskId,
      userId: row.user_id,
      isOpen: row.status === "pending",
      createdAt: row.created_at,
    });
  }

  const plan = decideTaskReminders({
    tasks,
    reminders,
    nowISO,
    zone: input.zone,
    firstHour: input.firstHour,
  });

  // Cerrar va primero: si la creación falla a medias, al menos la campanita
  // quedó limpia de avisos que ya no corresponden.
  const closed = await closeTaskReminders(
    plan.toClose.map((c) => c.notificationId),
  );

  let created = 0;
  for (const r of plan.toCreate) {
    await createNotification({
      user_id: r.userId,
      notification_type: TASK_REMINDER_NOTIFICATION_TYPE,
      origin: "system",
      origin_reference: {
        task_id: r.taskId,
        attempt: r.attempt,
        overdue_days: r.overdueDays,
      } as Json,
      opportunity_id: r.opportunityId,
      contact_id: r.contactId,
      title: r.title,
      message: r.message,
      amount_at_stake: null,
      due_at: r.dueAt,
      status: "pending",
      snoozed_until: null,
      schema_version: "1",
      completed_at: null,
    });
    created += 1;
  }

  const skipped: Partial<Record<SkipReason, number>> = {};
  for (const s of plan.skipped) {
    skipped[s.reason] = (skipped[s.reason] ?? 0) + 1;
  }

  return { evaluated: tasks.length, created, closed, skipped };
}
