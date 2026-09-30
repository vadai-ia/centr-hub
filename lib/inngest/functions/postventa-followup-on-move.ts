import "server-only";
import {
  getInngestClient,
  POSTVENTA_FOLLOWUP_MOVE_EVENT,
  type PostventaFollowupMoveEnvelope,
} from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { getOrganizationById } from "@/lib/db/organizations";
import { recordAuditEvent } from "@/lib/db/operational";
import { isPostventaFollowupMessageEnabled } from "@/lib/whaapy-postventa/config";
import { sendPostventaFollowup } from "@/lib/services/postventa-followup";

/**
 * Worker de la encuesta disparada por MOVER la tarjeta a "Seguimiento
 * post-entrega".
 *
 * Por qué existe: Post-venta ya arrastraba tarjetas a esa columna esperando
 * que eso mandara la encuesta, y no pasaba nada — la encuesta solo salía por
 * el cron, 7 días después del mensaje de entrega. Los pedidos entregados
 * ANTES de que existieran los mensajes nunca tuvieron ese ancla, así que por
 * la vía automática no la iban a recibir jamás.
 *
 * Ahora mover la tarjeta ES el disparo. La decisión la toma la persona; el
 * servicio solo conserva las guardas de elegibilidad (cancelada, resuelta,
 * caso problemático, ya enviada).
 *
 * Idempotencia: `followup_message_sent_at`. El cron mueve la tarjeta DESPUÉS
 * de sellar, así que su propio move llega aquí con el sello ya puesto y sale
 * por `already_sent` — no hay doble envío entre las dos vías.
 */

const inngest = getInngestClient();

export const postventaFollowupOnMove = inngest.createFunction(
  {
    id: "postventa-followup-on-move",
    retries: 3,
    triggers: [{ event: POSTVENTA_FOLLOWUP_MOVE_EVENT }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as PostventaFollowupMoveEnvelope;
    return withTenantContext(
      envelope.organizationId,
      async () => {
        // Mismo doble gate que el resto de los mensajes: el dispatch ya
        // checa, pero un evento EN VUELO al apagar el switch no debe salir.
        if (!isPostventaFollowupMessageEnabled()) {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "postventa_followup_suppressed_killswitch",
            entityType: "opportunity",
            entityId: envelope.opportunityId,
            payload: { reason: envelope.reason },
          });
          return { skipped: "killswitch" };
        }

        const org = await getOrganizationById(envelope.organizationId);
        const backfill = (org as unknown as { backfill_in_progress?: boolean })
          ?.backfill_in_progress;
        if (backfill) {
          // Durante el backfill las etapas se mueven por carga histórica: a
          // cada cliente antiguo le llegaría una encuesta.
          return { skipped: "backfill_in_progress" };
        }

        const result = await sendPostventaFollowup({
          organizationId: envelope.organizationId,
          opportunityId: envelope.opportunityId,
          trigger: "manual_move",
        });
        return result;
      },
      { source: "worker" },
    );
  },
);

export const postventaFollowupOnMoveFunctions = [postventaFollowupOnMove];
