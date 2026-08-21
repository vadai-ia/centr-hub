import "server-only";
import {
  getInngestClient,
  VENTA_DELIVERY_MESSAGE_EVENT,
  type VentaDeliveryMessageEnvelope,
} from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { getOrganizationById } from "@/lib/db/organizations";
import { recordAuditEvent } from "@/lib/db/operational";
import { isVentaDeliveryMessageEnabled } from "@/lib/whaapy/config";
import { pushVentaDeliveryMessage } from "@/lib/whaapy/venta-delivery-push";

/**
 * Worker del MENSAJE 1 — confirmación de entrega desde el número de VENTAS.
 *
 * Consume `whaapy/venta.delivery_message_requested` y mueve el contacto a la
 * etapa "Entregado" del funnel de Venta, que es lo que dispara la Automation
 * de Whaapy y con ella el template.
 *
 * Non-fatal de cara a la plataforma: la opp ya cambió de etapa antes de que
 * el hook encolara esto; un fallo de Whaapy solo deja pendiente el mensaje →
 * Inngest reintenta → DLQ tras agotar.
 *
 * Doble kill switch (espejo del worker de Post-venta): el dispatch ya gatea
 * el enqueue, pero un evento EN VUELO al togglear OFF no debe ejecutarse.
 * También se suprime durante el backfill: sin eso, procesar el histórico le
 * mandaría a cada cliente antiguo un "tu pedido fue entregado".
 */

const inngest = getInngestClient();

export const ventaDeliveryMessagePush = inngest.createFunction(
  {
    id: "venta-delivery-message-push",
    retries: 5,
    triggers: [{ event: VENTA_DELIVERY_MESSAGE_EVENT }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as VentaDeliveryMessageEnvelope;
    return withTenantContext(
      envelope.organizationId,
      async () => {
        if (!isVentaDeliveryMessageEnabled()) {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "venta_delivery_push_suppressed_killswitch",
            entityType: "opportunity",
            entityId: envelope.opportunityId,
            payload: { reason: envelope.reason },
          });
          return { discarded: true, reason: "kill_switch_off" };
        }

        const org = await getOrganizationById(envelope.organizationId);
        const backfill = (org as unknown as { backfill_in_progress?: boolean })
          ?.backfill_in_progress;
        if (backfill === true) {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "venta_delivery_push_suppressed_backfill",
            entityType: "opportunity",
            entityId: envelope.opportunityId,
            payload: { reason: envelope.reason },
          });
          return { discarded: true, reason: "backfill_in_progress" };
        }

        return await pushVentaDeliveryMessage({
          organizationId: envelope.organizationId,
          opportunityId: envelope.opportunityId,
        });
      },
      { source: "worker" },
    );
  },
);

export const ventaDeliveryFunctions = [ventaDeliveryMessagePush];
