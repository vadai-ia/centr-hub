import "server-only";
import {
  getInngestClient,
  LEAD_WEBHOOK_CREATE_EVENT,
  type LeadWebhookEnvelope,
} from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { createLead, LeadValidationError } from "@/lib/services/lead-creation";
import { touchInboundWebhookSourceUsed } from "@/lib/db/inbound-webhook-sources";
import { recordAuditEvent } from "@/lib/db/operational";
import type { StructuredAddress } from "@/lib/contacts/address";
import type { Json } from "@/lib/types/database";

/**
 * Worker de creación de lead por WEBHOOK (0038, Bloque B).
 *
 * Corre el camino canónico `createLead` con `source: "webhook"` y reparto
 * round-robin. El endpoint ya validó/dedupó/autenticó — aquí solo se crea
 * el lead (idéntico a la vía manual) y se marca la fuente como usada.
 *
 * Idempotencia extra: el propio `createLead` deduplica el contacto por
 * identidad y respeta una opp activa existente, así que un reintento de
 * Inngest sobre el mismo lead no duplica.
 */

const inngest = getInngestClient();

export const leadWebhookCreate = inngest.createFunction(
  {
    id: "lead-webhook-create",
    retries: 5,
    triggers: [{ event: LEAD_WEBHOOK_CREATE_EVENT }],
  },
  async ({ event }) => {
    const env = event.data as unknown as LeadWebhookEnvelope;
    return withTenantContext(
      env.organizationId,
      () => processLeadWebhook(env),
      { source: "worker" },
    );
  },
);

/** Núcleo sin el wrapper de tenant — separado para tests directos. */
export async function processLeadWebhook(env: LeadWebhookEnvelope): Promise<unknown> {
  try {
    const result = await createLead({
      fullName: env.payload.fullName,
      phone: env.payload.phone,
      email: env.payload.email,
      address: (env.payload.address ?? null) as Partial<StructuredAddress> | null,
      assignment: { mode: "round_robin" },
      source: "webhook",
      inboundWebhookSourceId: env.inboundWebhookSourceId,
      actorUserId: null,
    });

    // Marca la fuente como usada (best-effort — no rompe el lead).
    try {
      await touchInboundWebhookSourceUsed(env.inboundWebhookSourceId, env.receivedAt);
    } catch {
      // no bloquear
    }

    return result;
  } catch (err) {
    if (err instanceof LeadValidationError) {
      // Payload que pasó el endpoint pero falla en el canónico (ej. teléfono
      // no normalizable a E.164): un retry NO lo arregla → audita y termina.
      await recordAuditEvent({
        actorUserId: null,
        eventType: "lead_webhook_validation_failed",
        entityType: null,
        entityId: null,
        payload: {
          source_id: env.inboundWebhookSourceId,
          code: err.code,
          delivery_id: env.deliveryId,
        } as Json,
      });
      return { discarded: true, reason: err.code };
    }
    // Otros errores (BD, red) → throw → Inngest retry → DLQ.
    throw err;
  }
}

export const leadWebhookFunctions = [leadWebhookCreate];
