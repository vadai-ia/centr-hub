import "server-only";
import { getInngestClient } from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { getOrganizationById, listAllOrganizationIds } from "@/lib/db/organizations";
import { recordAuditEvent } from "@/lib/db/operational";
import { readOrganizationTimezone } from "@/lib/services/organization-timezone";
import { readOrganizationTaskReminderHour } from "@/lib/services/organization-task-reminder";
import { runTaskReminders } from "@/lib/services/task-reminder-run";

/**
 * Cron de los RECORDATORIOS DE TAREAS (punto 13 de la junta): "aviso el mismo
 * día a primera hora, con un recordatorio que insiste hasta que lo marquen".
 *
 * Cada hora, como el resto de crons del proyecto. La hora de arranque y la
 * zona salen de CADA organización (`config.defaults.task_reminder_hour` y
 * `timezone`), no de una constante: la expresión cron está en horario de
 * México y una tienda en Bogotá recibiría su aviso una hora corrida.
 *
 * Minuto 30 para no competir con el tick del motor de reglas (minuto 0) ni
 * con el seguimiento de Post-venta (minuto 15) — los tres recorren todas las
 * organizaciones y solaparlos solo alarga cada uno.
 *
 * NO tiene kill switch de env: solo escribe avisos DENTRO de la plataforma.
 * No manda WhatsApp ni correo, no mueve etapas, no toca dinero. Lo único que
 * puede hacer de más es poner un aviso en la campanita de alguien.
 *
 * Suprimido durante el backfill: importar el histórico puede traer tareas con
 * fechas viejas, y el primer tick las convertiría todas en avisos.
 *
 * Un fallo en una org NO aborta las demás.
 */

const inngest = getInngestClient();

export const taskReminderCron = inngest.createFunction(
  {
    id: "task-due-reminders-hourly",
    retries: 2,
    triggers: [{ cron: "TZ=America/Mexico_City 30 * * * *" }],
  },
  async () => {
    const orgIds = await listAllOrganizationIds();
    let createdTotal = 0;
    let closedTotal = 0;

    for (const orgId of orgIds) {
      try {
        const org = await getOrganizationById(orgId);
        if ((org as unknown as { backfill_in_progress?: boolean })?.backfill_in_progress) {
          continue;
        }
        const zone = readOrganizationTimezone(org?.config ?? null);
        const firstHour = readOrganizationTaskReminderHour(org?.config ?? null);

        const summary = await withTenantContext(
          orgId,
          () => runTaskReminders({ zone, firstHour }),
          { source: "worker" },
        );
        createdTotal += summary.created;
        closedTotal += summary.closed;

        if (summary.created > 0 || summary.closed > 0) {
          await withTenantContext(
            orgId,
            () =>
              recordAuditEvent({
                actorUserId: null,
                eventType: "task_reminders_tick_applied",
                entityType: "organization",
                entityId: orgId,
                payload: {
                  evaluated: summary.evaluated,
                  created: summary.created,
                  closed: summary.closed,
                  first_hour: firstHour,
                  timezone: zone,
                  skipped: summary.skipped,
                },
              }),
            { source: "worker" },
          );
        }
      } catch (err) {
        console.error(`[task-reminders] org ${orgId} falló:`, err);
      }
    }

    return { created: createdTotal, closed: closedTotal, orgs: orgIds.length };
  },
);

export const taskReminderFunctions = [taskReminderCron];
