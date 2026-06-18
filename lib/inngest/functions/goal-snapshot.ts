import "server-only";
import { getInngestClient } from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { listAllOrganizationIds } from "@/lib/db/organizations";
import { recordAuditEvent } from "@/lib/db/operational";
import { snapshotMonthlyGoals } from "@/lib/services/goal-snapshot";
import { previousMonthDateKey, resolvePreviousMonthPeriod } from "@/lib/time/period";

/**
 * Cron MENSUAL de snapshot del histórico de metas (M2v2 — Bloque 6).
 *
 * Corre el día 1 a las 01:00 America/Mexico_City — una hora después de la
 * medianoche para dar margen al cierre del mes. Congela en `goal_results` el
 * resultado del mes que acaba de terminar (`resolvePreviousMonthPeriod`),
 * por organización, dentro de `withTenantContext`. Idempotente: si ya hay
 * snapshots del mes, la org se salta. Un fallo aislado NO aborta las demás.
 *
 * A diferencia del resto de crons del proyecto (horarios), este es mensual:
 * el histórico de metas se cierra una vez por mes.
 */

const inngest = getInngestClient();

export const goalSnapshotCron = inngest.createFunction(
  {
    id: "goal-monthly-snapshot",
    retries: 2,
    triggers: [{ cron: "TZ=America/Mexico_City 0 1 1 * *" }],
  },
  async () => {
    const period = resolvePreviousMonthPeriod();
    const periodMonth = previousMonthDateKey();
    const orgIds = await listAllOrganizationIds();
    let writtenTotal = 0;

    for (const orgId of orgIds) {
      try {
        const res = await withTenantContext(
          orgId,
          () => snapshotMonthlyGoals({ period, periodMonth }),
          { source: "worker" },
        );
        writtenTotal += res.written;

        if (res.written > 0) {
          await withTenantContext(
            orgId,
            () =>
              recordAuditEvent({
                actorUserId: null,
                eventType: "goal_results_snapshot",
                entityType: "organization",
                entityId: orgId,
                payload: { period_month: periodMonth, written: res.written },
              }),
            { source: "worker" },
          );
        }
      } catch (err) {
        // No abortar el resto de orgs por un fallo aislado.
        // eslint-disable-next-line no-console
        console.error(
          `goal-monthly-snapshot: org ${orgId} falló:`,
          (err as Error).message,
        );
      }
    }

    return { organizations: orgIds.length, periodMonth, writtenTotal };
  },
);

export const goalSnapshotFunctions = [goalSnapshotCron];
