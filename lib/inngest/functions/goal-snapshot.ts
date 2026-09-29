import "server-only";
import { getInngestClient } from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { getOrganizationById, listAllOrganizationIds } from "@/lib/db/organizations";
import { readOrganizationTimezone } from "@/lib/services/organization-timezone";
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
    const orgIds = await listAllOrganizationIds();
    let writtenTotal = 0;
    // Solo para el valor de retorno: el mes REAL congelado se calcula por
    // organización, porque el borde del mes depende de su zona.
    let lastPeriodMonth = previousMonthDateKey();

    for (const orgId of orgIds) {
      try {
        // El mes que cierra se corta en la zona de CADA tienda. El cron
        // dispara a la 01:00 de México; para una tienda en Bogotá (una hora
        // adelante) las ventas de la primera hora del día 1 pertenecen al mes
        // NUEVO, y cortarlas con la zona de México las congelaría en el mes
        // que acaba de cerrar — revenue de octubre dentro del snapshot de
        // septiembre, ya inmutable.
        const timezone = readOrganizationTimezone(
          (await getOrganizationById(orgId))?.config ?? null,
        );
        const period = resolvePreviousMonthPeriod(timezone);
        const periodMonth = previousMonthDateKey(timezone);
        lastPeriodMonth = periodMonth;

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

    return { organizations: orgIds.length, periodMonth: lastPeriodMonth, writtenTotal };
  },
);

export const goalSnapshotFunctions = [goalSnapshotCron];
