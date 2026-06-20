import "server-only";
import { getInngestClient } from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { listAllOrganizationIds } from "@/lib/db/organizations";
import { listActivePostventaOppIds } from "@/lib/db/opportunities";
import {
  applyPostventaTransition,
  resolvePostventaEngineStages,
  isOrgBackfillInProgress,
  isPostventaEngineEnabled,
} from "@/lib/services/postventa-transition";
import { recordAuditEvent } from "@/lib/db/operational";

/**
 * Cron horario del motor de transiciones de Post-venta (M3v2, Bloque D).
 *
 * Red de seguridad del hook inline (orders.ts): cierra los huecos que un
 * webhook perdido, una carrera no resuelta (stale_version) o un estado que
 * cambió sin disparar webhook dejarían. Re-evalúa TODAS las opps de
 * Post-venta activas de cada org y las mueve a la etapa que corresponde al
 * estado de su pedido — idempotente (no-op si ya están bien).
 *
 * PRIMERA CORRIDA = backfill histórico: las opps que llevan en "Cotización
 * completada" desde el arranque saltan a la etapa real de su pedido
 * (pagado/en curso/entregado) sin tener que forzar un pedido por todos los
 * estados a mano (validación del checkpoint M3v2).
 *
 * Cada hora — cadencia de crons del proyecto (CLAUDE.md "Crons operativos
 * cada hora"; los dolores de Centr se miden en días). TZ explícito
 * America/Mexico_City. Por-org dentro de `withTenantContext`; un fallo en
 * una org NO aborta las demás.
 *
 * Eficiencia: las etapas del motor y el flag `backfill_in_progress` se
 * resuelven UNA vez por org y se pasan al driver, evitando relecturas por
 * cada opp.
 */

const inngest = getInngestClient();

export const postventaTransitionCron = inngest.createFunction(
  {
    id: "postventa-transition-engine-hourly",
    retries: 2,
    triggers: [{ cron: "TZ=America/Mexico_City 0 * * * *" }],
  },
  async () => {
    // Kill switch: hasta que el operador habilite el motor (tras revisar el
    // dry-run), el cron no mueve nada — evita que el primer backfill
    // histórico corra solo al desplegar (M3v2).
    if (!isPostventaEngineEnabled()) {
      return { skipped: "engine_disabled" as const };
    }

    const orgIds = await listAllOrganizationIds();
    let movedTotal = 0;
    let evaluatedTotal = 0;

    for (const orgId of orgIds) {
      try {
        const summary = await withTenantContext(
          orgId,
          async () => {
            // Modo pasivo durante backfill M11: no tocar nada.
            const backfillInProgress = await isOrgBackfillInProgress();
            if (backfillInProgress) {
              return { evaluated: 0, moved: 0, problem: 0, suppressed: true };
            }

            const engineStages = await resolvePostventaEngineStages();
            if (!engineStages) {
              return { evaluated: 0, moved: 0, problem: 0, suppressed: false };
            }

            const oppIds = await listActivePostventaOppIds();
            let moved = 0;
            let problem = 0;
            for (const oppId of oppIds) {
              const result = await applyPostventaTransition(oppId, {
                engineStages,
                backfillInProgress: false,
              });
              if (result.status === "moved") {
                moved += 1;
                if (result.toStageId === engineStages.problematicStage.id) {
                  problem += 1;
                }
              }
            }
            return {
              evaluated: oppIds.length,
              moved,
              problem,
              suppressed: false,
            };
          },
          { source: "worker" },
        );

        evaluatedTotal += summary.evaluated;
        movedTotal += summary.moved;

        // Solo audita cuando hubo movimientos (evita ruido por hora). Cada
        // movimiento ya queda auditado por opp dentro de moveOpportunityStage
        // (opportunity_stage_moved, context automation); esto es el resumen
        // por org del cron.
        if (summary.moved > 0) {
          await withTenantContext(
            orgId,
            () =>
              recordAuditEvent({
                actorUserId: null,
                eventType: "postventa_transition_cron_applied",
                entityType: "organization",
                entityId: orgId,
                payload: {
                  evaluated: summary.evaluated,
                  moved: summary.moved,
                  moved_to_problematic: summary.problem,
                },
              }),
            { source: "worker" },
          );
        }
      } catch (err) {
        // No abortar el resto de orgs por un fallo aislado.
        // eslint-disable-next-line no-console
        console.error(
          `postventa-transition-cron: org ${orgId} falló:`,
          (err as Error).message,
        );
      }
    }

    return {
      organizations: orgIds.length,
      evaluatedTotal,
      movedTotal,
    };
  },
);

export const postventaTransitionFunctions = [postventaTransitionCron];
