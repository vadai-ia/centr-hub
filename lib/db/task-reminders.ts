import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { TASK_REMINDER_NOTIFICATION_TYPE } from "@/lib/constants";
import type {
  ISODateString,
  NotificationRow,
  TaskRow,
  UUID,
} from "@/lib/types/database";

/**
 * Lecturas y cierres de los recordatorios de tareas (punto 13).
 *
 * Vive aparte de `operational.ts` —que ya pasa de 300 líneas— y no dentro del
 * servicio, para mantener la separación capa de datos / negocio: la decisión
 * de cuándo avisar es pura y no toca BD.
 */

/**
 * Tareas que PODRÍAN necesitar recordatorio: pendientes, con fecha, y cuya
 * fecha ya llegó. El corte superior entra como parámetro porque "hasta el
 * final de hoy" depende de la zona de la organización, que esta capa no
 * conoce.
 */
export async function listPendingTasksDueBy(
  untilISO: ISODateString,
): Promise<TaskRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .not("due_at", "is", null)
    .lte("due_at", untilISO)
    .order("due_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as TaskRow[];
}

/**
 * Recordatorios existentes que importan para la decisión: los ABIERTOS (que
 * siguen en la campanita) y los cerrados RECIENTES (que gobiernan la ventana
 * de insistencia). Los cerrados viejos no cambian ninguna decisión, así que
 * no se traen.
 */
export async function listRelevantTaskReminders(
  sinceISO: ISODateString,
): Promise<NotificationRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const base = () =>
    supabase
      .from("notifications")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("notification_type", TASK_REMINDER_NOTIFICATION_TYPE);
  // DOS lecturas en vez de un `.or()`: meter un timestamp ISO dentro de la
  // expresión `or` de PostgREST lo obliga a parsear un valor lleno de `:`,
  // `.` y `+`, y un fallo ahí devolvería "ningún recordatorio" — que se lee
  // igual que "no hay nada que avisar". La tabla es chica; dos queries
  // simples valen más que una frágil.
  const [abiertos, recientes] = await Promise.all([
    base().eq("status", "pending"),
    base().gte("created_at", sinceISO),
  ]);
  if (abiertos.error) throw abiertos.error;
  if (recientes.error) throw recientes.error;
  const porId = new Map<UUID, NotificationRow>();
  for (const row of [...(abiertos.data ?? []), ...(recientes.data ?? [])]) {
    porId.set(row.id, row);
  }
  return Array.from(porId.values());
}

/**
 * Cierra recordatorios en lote. `completed` y no `dismissed`: el aviso
 * cumplió su función (la tarea se marcó, o dejó de ser de esa persona), no
 * es algo que alguien haya desestimado.
 */
export async function closeTaskReminders(ids: UUID[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("notifications")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("notification_type", TASK_REMINDER_NOTIFICATION_TYPE)
    .in("id", ids)
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

/**
 * Cierra los recordatorios ABIERTOS de una tarea concreta. Lo invoca el
 * camino interactivo (marcar la tarea) para que la campanita se limpie en el
 * acto; el cron hace lo mismo como red de seguridad para cualquier otro
 * camino que cierre una tarea.
 */
export async function closeOpenRemindersForTask(taskId: UUID): Promise<number> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("notifications")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("notification_type", TASK_REMINDER_NOTIFICATION_TYPE)
    .eq("status", "pending")
    .contains("origin_reference", { task_id: taskId })
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}
