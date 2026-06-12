import "server-only";
import { getInngestClient } from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { listAllOrganizationIds } from "@/lib/db/organizations";
import { tickHourly } from "@/lib/services/rules-engine";
import { recordAuditEvent } from "@/lib/db/operational";

/**
 * Cron horario del motor de reglas (M1v2 — Bloque A2).
 *
 * Reusa exactamente la plantilla de `advisor-reconciliation`: cada hora,
 * por organización dentro de `withTenantContext`, dispara `tickHourly`:
 *   1) reactiva tareas/avisos snoozeados cuyo plazo venció;
 *   2) evalúa las reglas activas con triggers de tiempo (stage_aging,
 *      no_activity, contact.no_activity) y crea tareas + avisos.
 *
 * Cada hora — cadencia de crons del proyecto (CLAUDE.md "Crons operativos
 * cada hora"). TZ explícito America/Mexico_City. Un fallo en una org NO
 * aborta las demás: se loguea y se continúa. Idempotencia R4 vive en el
 * motor (no duplica mientras haya tarea/aviso abierto de la misma regla).
 */

const inngest = getInngestClient();

export const ruleEvaluationCron = inngest.createFunction(
  {
    id: "automation-rules-tick-hourly",
    retries: 2,
    triggers: [{ cron: "TZ=America/Mexico_City 0 * * * *" }],
  },
  async () => {
    const orgIds = await listAllOrganizationIds();
    let actionsTotal = 0;
    let reactivatedTotal = 0;
    let disabledTotal = 0;

    for (const orgId of orgIds) {
      try {
        const summary = await withTenantContext(orgId, () => tickHourly(), {
          source: "worker",
        });
        actionsTotal += summary.actionsApplied;
        reactivatedTotal += summary.reactivatedTasks + summary.reactivatedNotifications;
        disabledTotal += summary.rulesDisabled;

        if (
          summary.actionsApplied > 0 ||
          summary.rulesDisabled > 0 ||
          summary.reactivatedTasks + summary.reactivatedNotifications > 0
        ) {
          await withTenantContext(
            orgId,
            () =>
              recordAuditEvent({
                actorUserId: null,
                eventType: "automation_rules_tick_applied",
                entityType: "organization",
                entityId: orgId,
                payload: {
                  actions_applied: summary.actionsApplied,
                  reactivated_tasks: summary.reactivatedTasks,
                  reactivated_notifications: summary.reactivatedNotifications,
                  rules_disabled: summary.rulesDisabled,
                },
              }),
            { source: "worker" },
          );
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `automation-rules-tick: org ${orgId} falló:`,
          (err as Error).message,
        );
      }
    }

    return {
      organizations: orgIds.length,
      actionsTotal,
      reactivatedTotal,
      disabledTotal,
    };
  },
);

export const ruleEvaluationFunctions = [ruleEvaluationCron];
