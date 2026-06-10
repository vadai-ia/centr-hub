import "server-only";
import { getInngestClient } from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { listAllOrganizationIds } from "@/lib/db/organizations";
import { reconcileAdvisorAttribution } from "@/lib/services/advisor-reconciliation";
import { recordAuditEvent } from "@/lib/db/operational";

/**
 * Cron horario de reconciliación de atribución de asesor (red de
 * seguridad — fix caso Eduardo Badir).
 *
 * Los hooks en vivo de orders/* (0022/0023) cubren el camino feliz. Este
 * cron cierra los huecos que un webhook perdido o una carrera no resuelta
 * dejarían: re-corre los MISMOS RPC, idempotentes, para cada organización.
 *
 * Cada hora — alineado con la cadencia de crons del proyecto (CLAUDE.md
 * "Crons operativos cada hora"; los dolores de Centr se miden en días, una
 * hora es resolución de sobra). TZ explícito America/Mexico_City.
 *
 * Por-org dentro de `withTenantContext` (mismo patrón que tag-reprocess):
 * los RPC y las queries usan getTenantScopedClient. Un fallo en una org NO
 * aborta las demás — se audita y se continúa.
 */

const inngest = getInngestClient();

export const advisorReconciliationCron = inngest.createFunction(
  {
    id: "advisor-reattribution-reconcile",
    retries: 2,
    triggers: [{ cron: "TZ=America/Mexico_City 0 * * * *" }],
  },
  async () => {
    const orgIds = await listAllOrganizationIds();
    let ventaFixedTotal = 0;
    let childFixedTotal = 0;

    for (const orgId of orgIds) {
      try {
        const result = await withTenantContext(
          orgId,
          () =>
            reconcileAdvisorAttribution({
              dryRun: false,
              source: "reconcile_cron",
            }),
          { source: "worker" },
        );
        ventaFixedTotal += result.ventaChanged.length;
        childFixedTotal += result.childChanged.length;

        // Solo audita cuando hubo deriva real corregida (evita ruido por
        // hora). El audit ya queda por opp/hija dentro de cada RPC; esto
        // es un resumen por org del cron.
        if (result.ventaChanged.length > 0 || result.childChanged.length > 0) {
          await withTenantContext(
            orgId,
            () =>
              recordAuditEvent({
                actorUserId: null,
                eventType: "advisor_reconcile_cron_applied",
                entityType: "organization",
                entityId: orgId,
                payload: {
                  venta_fixed: result.ventaChanged.length,
                  child_fixed: result.childChanged.length,
                },
              }),
            { source: "worker" },
          );
        }
      } catch (err) {
        // No abortar el resto de orgs por un fallo aislado.
        // eslint-disable-next-line no-console
        console.error(
          `advisor-reconcile-cron: org ${orgId} falló:`,
          (err as Error).message,
        );
      }
    }

    return {
      organizations: orgIds.length,
      ventaFixedTotal,
      childFixedTotal,
    };
  },
);

export const advisorReconciliationFunctions = [advisorReconciliationCron];
