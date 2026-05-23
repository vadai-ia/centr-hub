import "server-only";
import { withTenantContext } from "@/lib/tenant/context";
import { recordAuditEvent } from "@/lib/db/operational";
import type {
  ShopifyWebhookEnvelope,
  WhaapyWebhookEnvelope,
} from "@/lib/inngest/client";
import type { Json, UUID } from "@/lib/types/database";

/**
 * Helper compartido por los 12 workers de webhooks Shopify.
 *
 * Encapsula la disciplina común:
 *   - Activación de contexto de tenant (Barrera 2).
 *   - Audit log `shopify_webhook_received` antes de ejecutar el body.
 *   - Audit log `shopify_webhook_failed` si el callback throwea.
 *   - Re-throw para que Inngest reintente — la responsabilidad
 *     de idempotencia vive en el callback.
 *
 * Idempotencia: el dedup en Upstash filtra entregas múltiples del
 * mismo `eventId`. Aún así cada worker debe ser idempotente por
 * naturaleza (upserts con conflict handling, comparación LWW).
 */

export async function runWebhookWorker<T>(
  envelope: ShopifyWebhookEnvelope,
  topic: string,
  callback: (env: ShopifyWebhookEnvelope) => Promise<T>,
): Promise<T> {
  return withTenantContext(
    envelope.organizationId,
    async () => {
      await recordAuditEvent({
        actorUserId: null,
        eventType: "shopify_webhook_received",
        entityType: topic.split("/")[0] ?? null,
        entityId: null,
        payload: {
          topic,
          shopify_event_id: envelope.eventId,
          shop_domain: envelope.shopDomain,
          triggered_at: envelope.triggeredAt,
        } as Json,
      });
      try {
        return await callback(envelope);
      } catch (err) {
        await recordAuditEvent({
          actorUserId: null,
          eventType: "shopify_webhook_failed",
          entityType: topic.split("/")[0] ?? null,
          entityId: null,
          payload: {
            topic,
            shopify_event_id: envelope.eventId,
            error: (err as Error)?.message ?? String(err),
          },
        });
        throw err;
      }
    },
    { source: "webhook" },
  );
}

export function asUUID(value: string): UUID {
  return value as UUID;
}

/**
 * Espejo de `runWebhookWorker` para webhooks Whaapy (M4). Idéntica
 * disciplina (tenant context, audit log received/failed, re-throw para
 * retry). Diferencia: el envelope usa `whaapyBusinessId` en lugar de
 * `shopDomain` y los event types se prefijan con `whaapy_webhook_`.
 */
export async function runWhaapyWebhookWorker<T>(
  envelope: WhaapyWebhookEnvelope,
  topic: string,
  callback: (env: WhaapyWebhookEnvelope) => Promise<T>,
): Promise<T> {
  return withTenantContext(
    envelope.organizationId,
    async () => {
      await recordAuditEvent({
        actorUserId: null,
        eventType: "whaapy_webhook_received",
        entityType: topic.split(".")[0] ?? null,
        entityId: null,
        payload: {
          topic,
          whaapy_delivery_id: envelope.deliveryId,
          whaapy_business_id: envelope.whaapyBusinessId,
          received_at: envelope.receivedAt,
        } as Json,
      });
      try {
        return await callback(envelope);
      } catch (err) {
        await recordAuditEvent({
          actorUserId: null,
          eventType: "whaapy_webhook_failed",
          entityType: topic.split(".")[0] ?? null,
          entityId: null,
          payload: {
            topic,
            whaapy_delivery_id: envelope.deliveryId,
            error: (err as Error)?.message ?? String(err),
          },
        });
        throw err;
      }
    },
    { source: "webhook" },
  );
}
