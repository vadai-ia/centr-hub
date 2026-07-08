import "server-only";
import {
  getInngestClient,
  WHAAPY_POSTVENTA_STAGE_PUSH_EVENT,
  type WhaapyPostventaStagePushEnvelope,
} from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { getOrganizationById } from "@/lib/db/organizations";
import { recordAuditEvent } from "@/lib/db/operational";
import { isPostventaWhaapySyncEnabled } from "@/lib/whaapy-postventa/config";
import { pushPostventaStage } from "@/lib/whaapy-postventa/push-service";

/**
 * Worker outbound del Whaapy de POST-VENTA (webhooks 1, 2, 4).
 *
 * Consume `whaapy/postventa.stage_push_requested` y ejecuta el push de
 * etapa (match por teléfono → custom_fields → move). Non-fatal de cara a
 * la plataforma: el cambio de etapa de la opp ya commiteó antes de que el
 * hook encolara este evento; un fallo de Whaapy solo deja pendiente la
 * propagación → Inngest reintenta → DLQ tras agotar.
 *
 * Doble kill switch (defensa): el dispatch ya gatea el enqueue, pero un
 * evento en vuelo al togglear OFF no debe ejecutarse. También se suprime
 * durante el backfill M11 (espejo del outbound de Venta y del motor).
 */

const inngest = getInngestClient();

export const whaapyPostventaStagePush = inngest.createFunction(
  {
    id: "whaapy-postventa-stage-push",
    retries: 5,
    triggers: [{ event: WHAAPY_POSTVENTA_STAGE_PUSH_EVENT }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as WhaapyPostventaStagePushEnvelope;
    return withTenantContext(
      envelope.organizationId,
      async () => {
        if (!isPostventaWhaapySyncEnabled()) {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "postventa_whaapy_push_suppressed_killswitch",
            entityType: "opportunity",
            entityId: envelope.opportunityId,
            payload: { target: envelope.target, reason: envelope.reason },
          });
          return { discarded: true, reason: "kill_switch_off" };
        }

        const org = await getOrganizationById(envelope.organizationId);
        const backfill = (org as unknown as { backfill_in_progress?: boolean })
          ?.backfill_in_progress;
        if (backfill === true) {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "postventa_whaapy_push_suppressed_backfill",
            entityType: "opportunity",
            entityId: envelope.opportunityId,
            payload: { target: envelope.target, reason: envelope.reason },
          });
          return { discarded: true, reason: "backfill_in_progress" };
        }

        const result = await pushPostventaStage({
          organizationId: envelope.organizationId,
          opportunityId: envelope.opportunityId,
          target: envelope.target,
        });
        return result;
      },
      { source: "worker" },
    );
  },
);

export const whaapyPostventaFunctions = [whaapyPostventaStagePush];
