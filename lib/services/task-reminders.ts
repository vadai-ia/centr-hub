import { DateTime } from "luxon";
import { TASK_REMINDER_REINSIST_HOURS } from "@/lib/constants";
import type { ISODateString, TaskStatus, UUID } from "@/lib/types/database";

/**
 * Recordatorios de tareas (punto 13 de la junta): "aviso el mismo día a
 * primera hora, con un recordatorio que insiste hasta que lo marquen".
 *
 * Este módulo es la DECISIÓN y es PURO — el "ahora", la zona y la hora de
 * arranque entran como parámetros. La lectura y escritura viven en el cron.
 * La razón de separarlo: el comportamiento que importa (cuándo avisa, cuándo
 * insiste, cuándo se calla) es todo lógica temporal, y probarla contra una
 * BD sería probar Postgres en vez de la regla.
 */

/** Una tarea tal como la necesita la decisión. */
export interface ReminderTask {
  id: UUID;
  assignedUserId: UUID;
  title: string;
  dueAt: ISODateString | null;
  status: TaskStatus;
  opportunityId: UUID | null;
  contactId: UUID | null;
}

/** Un recordatorio ya existente, en cualquier estado. */
export interface ExistingReminder {
  id: UUID;
  taskId: UUID;
  userId: UUID;
  /** `pending` = sigue en la campanita. Cualquier otro = ya lo cerró alguien. */
  isOpen: boolean;
  createdAt: ISODateString;
}

export interface ReminderToCreate {
  taskId: UUID;
  userId: UUID;
  title: string;
  message: string;
  dueAt: ISODateString | null;
  opportunityId: UUID | null;
  contactId: UUID | null;
  /** Cuántas veces se ha insistido ya con esta tarea, contando esta. */
  attempt: number;
  overdueDays: number;
}

export interface ReminderToClose {
  notificationId: UUID;
  reason: "task_not_pending" | "reassigned";
}

export interface ReminderPlan {
  toCreate: ReminderToCreate[];
  toClose: ReminderToClose[];
  /** Por qué NO se avisó de cada tarea candidata — alimenta el audit. */
  skipped: Array<{ taskId: UUID; reason: SkipReason }>;
}

export type SkipReason =
  | "no_due_date"
  | "not_pending"
  | "not_due_yet"
  | "before_first_hour"
  | "already_open"
  | "recently_reminded";

export interface DecideInput {
  tasks: ReminderTask[];
  reminders: ExistingReminder[];
  nowISO: ISODateString;
  /** Zona de la organización: decide qué día es "hoy" y cuándo es la hora. */
  zone: string;
  /** Hora local a partir de la cual se avisa. */
  firstHour: number;
  reinsistHours?: number;
}

/**
 * Qué recordatorios crear y cuáles cerrar.
 *
 * El cierre va PRIMERO en importancia: sin él, completar una tarea dejaría su
 * aviso en la campanita para siempre, y la persona aprendería a ignorarla —
 * que es exactamente el fracaso de una función cuyo propósito es insistir.
 */
export function decideTaskReminders(input: DecideInput): ReminderPlan {
  const reinsistHours = input.reinsistHours ?? TASK_REMINDER_REINSIST_HOURS;
  const now = DateTime.fromISO(input.nowISO, { zone: input.zone });
  const toCreate: ReminderToCreate[] = [];
  const toClose: ReminderToClose[] = [];
  const skipped: Array<{ taskId: UUID; reason: SkipReason }> = [];

  if (!now.isValid) return { toCreate, toClose, skipped };

  const byTask = new Map<UUID, ReminderTask>(input.tasks.map((t) => [t.id, t]));
  const remindersByTask = new Map<UUID, ExistingReminder[]>();
  for (const r of input.reminders) {
    const list = remindersByTask.get(r.taskId) ?? [];
    list.push(r);
    remindersByTask.set(r.taskId, list);
  }

  // --- 1) Cerrar lo que ya no corresponde ---
  for (const r of input.reminders) {
    if (!r.isOpen) continue;
    const task = byTask.get(r.taskId);
    // La tarea desapareció de la lista de pendientes: la completaron, la
    // snoozearon o la borraron. En los tres casos el aviso sobra.
    if (!task || task.status !== "pending") {
      toClose.push({ notificationId: r.id, reason: "task_not_pending" });
      continue;
    }
    // La tarea cambió de dueño (reasignación): el aviso sigue colgado de la
    // persona anterior, que ya no puede hacer nada con él. Se cierra y el
    // ciclo de abajo le crea uno al dueño nuevo.
    if (task.assignedUserId !== r.userId) {
      toClose.push({ notificationId: r.id, reason: "reassigned" });
    }
  }

  const closing = new Set(toClose.map((c) => c.notificationId));
  const beforeFirstHour = now.hour < input.firstHour;
  const todayKey = now.toISODate();

  // --- 2) Crear / insistir ---
  for (const task of input.tasks) {
    if (task.status !== "pending") {
      skipped.push({ taskId: task.id, reason: "not_pending" });
      continue;
    }
    if (!task.dueAt) {
      // Sin fecha no hay día en que avisar. La tarea sigue viva en Mi Día.
      skipped.push({ taskId: task.id, reason: "no_due_date" });
      continue;
    }
    const due = DateTime.fromISO(task.dueAt, { zone: input.zone });
    if (!due.isValid) {
      skipped.push({ taskId: task.id, reason: "no_due_date" });
      continue;
    }
    const dueKey = due.toISODate();
    // Se avisa el día que vence y todos los días que siga vencida. Una tarea
    // de mañana no interrumpe hoy.
    if (dueKey === null || todayKey === null || dueKey > todayKey) {
      skipped.push({ taskId: task.id, reason: "not_due_yet" });
      continue;
    }
    if (beforeFirstHour) {
      // "A primera hora" es un piso, no una ventana: el tick de las 8 avisa,
      // los de las 7 y antes no. Si alguien crea una tarea para hoy a las
      // 11, el tick de las 11 la toma — no hay que esperar a mañana.
      skipped.push({ taskId: task.id, reason: "before_first_hour" });
      continue;
    }

    const existing = (remindersByTask.get(task.id) ?? []).filter(
      (r) => !closing.has(r.id),
    );
    if (existing.some((r) => r.isOpen)) {
      // Ya está en su campanita. Crear otro sería el mismo aviso dos veces.
      skipped.push({ taskId: task.id, reason: "already_open" });
      continue;
    }
    const lastAt = existing.reduce<string | null>(
      (acc, r) => (acc === null || r.createdAt > acc ? r.createdAt : acc),
      null,
    );
    if (lastAt !== null) {
      const hoursSince = now.diff(
        DateTime.fromISO(lastAt, { zone: input.zone }),
        "hours",
      ).hours;
      if (hoursSince < reinsistHours) {
        // Lo descartó hace poco sin completar la tarea. Insistir en el
        // siguiente tick convertiría el aviso en algo imposible de quitar.
        skipped.push({ taskId: task.id, reason: "recently_reminded" });
        continue;
      }
    }

    const overdueDays = Math.max(
      Math.floor(now.startOf("day").diff(due.startOf("day"), "days").days),
      0,
    );
    toCreate.push({
      taskId: task.id,
      userId: task.assignedUserId,
      title: reminderTitle(overdueDays),
      message: reminderMessage(task.title, overdueDays),
      dueAt: task.dueAt,
      opportunityId: task.opportunityId,
      contactId: task.contactId,
      attempt: existing.length + 1,
      overdueDays,
    });
  }

  return { toCreate, toClose, skipped };
}

/**
 * El título dice el estado, no solo "tienes una tarea": una vencida de hace
 * cuatro días y una de hoy no piden la misma reacción, y un aviso que se lee
 * igual el día uno y el día cuatro es el que se aprende a ignorar.
 */
export function reminderTitle(overdueDays: number): string {
  if (overdueDays <= 0) return "Tarea para hoy";
  if (overdueDays === 1) return "Tarea vencida ayer";
  return `Tarea vencida hace ${overdueDays} días`;
}

export function reminderMessage(taskTitle: string, overdueDays: number): string {
  const clean = taskTitle.trim() || "Tarea sin título";
  if (overdueDays <= 0) {
    return `${clean} — vence hoy. Márcala cuando la termines.`;
  }
  return `${clean} — sigue pendiente. Márcala cuando la termines o cámbiale la fecha.`;
}
