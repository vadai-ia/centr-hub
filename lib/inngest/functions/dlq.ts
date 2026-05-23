import "server-only";
import { getInngestClient } from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { recordAuditEvent, createNotification } from "@/lib/db/operational";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { UUID } from "@/lib/types/database";

/**
 * Dead Letter Queue handler (M3).
 *
 * Inngest emite el evento sintético `inngest/function.failed` cuando
 * una función agota sus reintentos. Este handler:
 *   1. Lee el envelope original (function_id, run_id, error,
 *      original event data).
 *   2. Resuelve organization_id del payload original.
 *   3. Registra audit log `inngest_dlq` + notificación type=alert
 *      a TODOS los admins activos de la org afectada.
 *
 * UI dedicada para gestionar DLQ es V2 — por ahora notificación
 * + audit son suficientes para que el operador tome acción manual.
 */

const inngest = getInngestClient();

interface FailedEventData {
  function_id?: string;
  run_id?: string;
  error?: { name?: string; message?: string };
  // `eventId` viene en envelopes Shopify; `deliveryId` en envelopes
  // Whaapy (rename M4). El DLQ es agnóstico de proveedor — toma el
  // primero que esté presente.
  event?: {
    data?: {
      organizationId?: UUID;
      eventId?: string;
      deliveryId?: string;
      topic?: string;
    };
  };
}

export const dlqHandler = inngest.createFunction(
  {
    id: "inngest-dlq-handler",
    // Se suscribe a TODOS los failures de funciones del proyecto.
    // El namespace `centr-hub` viene de inngest.createClient.id.
    triggers: [{ event: "inngest/function.failed" }],
  },
  async ({ event }) => {
    const data = (event as { data?: FailedEventData }).data ?? {};
    const orgId = data.event?.data?.organizationId;
    const functionId = data.function_id ?? "unknown";
    const runId = data.run_id ?? "unknown";
    const errorMessage = data.error?.message ?? "unknown_error";
    const originalEventId =
      data.event?.data?.eventId ?? data.event?.data?.deliveryId ?? null;
    const originalTopic = data.event?.data?.topic ?? null;

    if (!orgId) {
      // Sin tenant context no podemos notificar; solo log a stdout.
      // eslint-disable-next-line no-console
      console.error("inngest_dlq_without_org", {
        functionId,
        runId,
        errorMessage,
      });
      return { handled: false, reason: "no_organization_id" };
    }

    return withTenantContext(
      orgId,
      async () => {
        await recordAuditEvent({
          actorUserId: null,
          eventType: "inngest_dlq",
          entityType: "function",
          entityId: null,
          payload: {
            function_id: functionId,
            run_id: runId,
            error_message: errorMessage,
            original_event_id: originalEventId,
            original_topic: originalTopic,
          },
        });

        // Notificar a admins activos de la org.
        const supabase = getSupabaseAdminClient();
        const { data: admins } = await supabase
          .from("memberships")
          .select("user_id")
          .eq("organization_id", orgId)
          .eq("role", "admin")
          .eq("is_active", true);
        if (admins && admins.length > 0) {
          for (const adm of admins) {
            await createNotification({
              user_id: (adm as { user_id: UUID }).user_id,
              notification_type: "system_failure_dlq",
              origin: "system",
              origin_reference: {
                function_id: functionId,
                run_id: runId,
                error: errorMessage,
                original_topic: originalTopic,
              },
              opportunity_id: null,
              contact_id: null,
              title: "Sincronización falló tras reintentos",
              message: `${functionId} no pudo completar (${errorMessage}). Revisar logs Inngest.`,
              amount_at_stake: null,
              due_at: null,
              status: "pending",
              snoozed_until: null,
              schema_version: "1",
              completed_at: null,
            });
          }
        }

        return { handled: true, adminsNotified: admins?.length ?? 0 };
      },
      { source: "worker" },
    );
  },
);

export const dlqFunctions = [dlqHandler];
