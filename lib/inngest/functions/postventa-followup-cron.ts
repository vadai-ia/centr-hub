import "server-only";
import { getInngestClient } from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { getOrganizationById, listAllOrganizationIds } from "@/lib/db/organizations";
import { recordAuditEvent } from "@/lib/db/operational";
import {
  isPostventaFollowupMessageEnabled,
  POSTVENTA_FOLLOWUP_DELAY_DAYS,
} from "@/lib/whaapy-postventa/config";
import {
  listOpportunitiesDueForFollowup,
  sendPostventaFollowup,
} from "@/lib/services/postventa-followup";

/**
 * Cron del MENSAJE 2 — seguimiento "7 dias" desde el número de Post-venta.
 *
 * Whaapy no tiene disparador con retraso: sus triggers reaccionan a mensajes,
 * a entrada de etapa o a horario, nunca a "N días después de X". El
 * temporizador tiene que vivir aquí.
 *
 * Cada hora, como el resto de crons del proyecto. La consecuencia visible es
 * que el mensaje sale entre 7 días y 7 días + 1 hora después del primero —
 * holgura irrelevante para un seguimiento post-entrega.
 *
 * Kill switch PROPIO (`POSTVENTA_FOLLOWUP_MESSAGE_ENABLED`), independiente
 * del de la sincronización de casos: es un mensaje de MARKETING que sale
 * solo, sin que nadie lo dispare, y hay que poder apagarlo sin apagar la
 * propagación de casos problemáticos.
 *
 * Suprimido durante el backfill: sin esa guarda, importar el histórico
 * marcaría entregas viejas y a la hora siguiente el cron le mandaría un
 * "¿estás disfrutando tu equipo?" a cientos de clientes de hace meses.
 *
 * Un fallo en una org NO aborta las demás.
 */

const inngest = getInngestClient();

export const postventaFollowupCron = inngest.createFunction(
  {
    id: "postventa-followup-message-hourly",
    retries: 2,
    triggers: [{ cron: "TZ=America/Mexico_City 15 * * * *" }],
  },
  async () => {
    if (!isPostventaFollowupMessageEnabled()) {
      return { skipped: "followup_disabled" as const };
    }

    const orgIds = await listAllOrganizationIds();
    let sentTotal = 0;
    let evaluatedTotal = 0;

    for (const orgId of orgIds) {
      try {
        const org = await getOrganizationById(orgId);
        if ((org as unknown as { backfill_in_progress?: boolean })?.backfill_in_progress) {
          continue;
        }

        await withTenantContext(
          orgId,
          async () => {
            const due = await listOpportunitiesDueForFollowup();
            evaluatedTotal += due.length;
            for (const opportunityId of due) {
              const res = await sendPostventaFollowup({
                organizationId: orgId,
                opportunityId,
              });
              if (res.ok && res.sent) sentTotal += 1;
            }
            if (due.length > 0) {
              await recordAuditEvent({
                actorUserId: null,
                eventType: "postventa_followup_cron_ran",
                entityType: "organization",
                entityId: orgId,
                payload: { evaluated: due.length, delay_days: POSTVENTA_FOLLOWUP_DELAY_DAYS },
              });
            }
          },
          { source: "worker" },
        );
      } catch (err) {
        // Aislado por org: una credencial rota en una tienda no debe dejar
        // sin seguimiento a las demás.
        console.error(
          `[postventa-followup] org ${orgId} falló:`,
          (err as Error).message,
        );
      }
    }

    return { evaluated: evaluatedTotal, sent: sentTotal };
  },
);

export const postventaFollowupFunctions = [postventaFollowupCron];
