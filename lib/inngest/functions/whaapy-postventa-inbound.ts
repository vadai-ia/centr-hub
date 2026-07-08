import "server-only";
import {
  getInngestClient,
  WHAAPY_POSTVENTA_INBOUND_EVENT,
  type WhaapyPostventaInboundEnvelope,
} from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { recordAuditEvent, createNotification } from "@/lib/db/operational";
import { normalizePhone } from "@/lib/services/identity-matching";
import { findContactByPhoneOrEmail } from "@/lib/db/contacts";
import { listOpportunities } from "@/lib/db/opportunities";
import { resolvePostventaStages } from "@/lib/services/dashboard-stages";
import { resolvePostventaCase } from "@/lib/services/postventa-case-resolution";
import { resolvePostventaResolverUserId } from "@/lib/whaapy-postventa/resolver-user";
import type { Json, OpportunityRow, UUID } from "@/lib/types/database";

/**
 * Worker INBOUND del Whaapy de Post-venta (webhook 3 — Option A).
 *
 * Lo dispara la Automation `http_request` en "Caso Resuelto"; el body trae
 * SOLO el teléfono (los custom_fields no son variables de automation, y el
 * funnel de Whaapy es contact-céntrico: un contacto tiene UNA etapa, sin
 * id por-caso — confirmado en la doc de Funnels). Archiva la opp reusando
 * `resolvePostventaCase(source: "whaapy_postventa_inbound")` — idempotente
 * y ANTI-BUCLE capa 1 (no re-propaga a Whaapy).
 *
 * Match SIN heurística de adivinanza:
 *   - Candidatos = opps del contacto EN "Caso problemático" y NO resueltas.
 *   - Exactamente 1 candidato → se resuelve (es inequívocamente el caso).
 *   - 0 candidatos → no-op.
 *   - ≥2 candidatos → NO se auto-archiva (Whaapy no puede indicar cuál): se
 *     audita `postventa_whaapy_inbound_needs_manual_review` + se notifica a
 *     Customer Success para que resuelva el correcto en la plataforma.
 *
 * (Se conserva un fast-path por `opportunity_id` explícito del body, hoy no
 * enviado por Option A pero seguro: `resolvePostventaCase` valida etapa +
 * no-resuelto, así que un id fuera de "Caso problemático" es no-op.)
 */

const inngest = getInngestClient();

export const whaapyPostventaInbound = inngest.createFunction(
  {
    id: "whaapy-postventa-inbound",
    retries: 5,
    triggers: [{ event: WHAAPY_POSTVENTA_INBOUND_EVENT }],
  },
  async ({ event }) => {
    const env = event.data as unknown as WhaapyPostventaInboundEnvelope;
    return withTenantContext(
      env.organizationId,
      () => processPostventaInbound(env),
      { source: "worker" },
    );
  },
);

/**
 * Núcleo del webhook 3 (sin el wrapper de tenant — lo aporta el handler).
 * Separado para tests unitarios directos.
 */
export async function processPostventaInbound(
  env: WhaapyPostventaInboundEnvelope,
): Promise<Record<string, unknown>> {
  // Fast-path: id explícito (no enviado por Option A; seguro por los guards
  // de resolvePostventaCase).
  if (env.opportunityId) {
    return archiveCase(env, env.opportunityId as UUID);
  }

  const phone = normalizePhone(env.phone);
  if (!phone) {
    await audit(null, "postventa_whaapy_inbound_no_match", {
      reason: "missing_phone",
      delivery_id: env.deliveryId,
    });
    return { discarded: true, reason: "missing_phone" };
  }

  const contact = await findContactByPhoneOrEmail({ phone });
  if (!contact) {
    await audit(null, "postventa_whaapy_inbound_no_match", {
      reason: "contact_not_found",
      delivery_id: env.deliveryId,
    });
    return { discarded: true, reason: "contact_not_found" };
  }

  const { problematicStage } = await resolvePostventaStages();
  if (!problematicStage) {
    await audit(null, "postventa_whaapy_inbound_no_problematic_stage", {
      delivery_id: env.deliveryId,
    });
    return { discarded: true, reason: "no_problematic_stage" };
  }

  // Candidatos: SOLO "Caso problemático" (scope de ask #1) y NO resueltos.
  const opps = await listOpportunities({
    funnel: "post_venta",
    stageId: problematicStage.id,
    contactId: contact.id as UUID,
  });
  const active = opps.filter((o) => !o.resolved_at);

  if (active.length === 0) {
    await audit(null, "postventa_whaapy_inbound_no_match", {
      reason: "no_active_problem_case",
      contact_id: contact.id,
      delivery_id: env.deliveryId,
    });
    return { discarded: true, reason: "no_active_problem_case" };
  }

  if (active.length === 1) {
    return archiveCase(env, active[0].id as UUID);
  }

  // ≥2 casos activos: ambigüedad INHERENTE al modelo de Whaapy (un contacto,
  // una etapa, sin id por-caso). NO adivinamos — dejamos que una persona
  // resuelva el correcto en la plataforma.
  await handleAmbiguous(env, contact.id as UUID, active);
  return { discarded: true, reason: "ambiguous_multiple_cases" };
}

async function archiveCase(
  env: WhaapyPostventaInboundEnvelope,
  opportunityId: UUID,
): Promise<Record<string, unknown>> {
  const resolverUserId = await resolvePostventaResolverUserId(env.organizationId);
  if (!resolverUserId) {
    await audit(opportunityId, "postventa_whaapy_inbound_resolver_unresolved", {
      delivery_id: env.deliveryId,
    });
    return { discarded: true, reason: "resolver_unresolved" };
  }

  // ANTI-BUCLE capa 1: source inbound → resolvePostventaCase NO re-dispara
  // el webhook 4 hacia Whaapy. Idempotente si ya resuelta; guards de etapa.
  const result = await resolvePostventaCase({
    opportunityId,
    resolvedByUserId: resolverUserId,
    note: "Resuelto en Whaapy Post-venta",
    source: "whaapy_postventa_inbound",
  });

  await audit(opportunityId, "postventa_whaapy_inbound_processed", {
    resolve_ok: result.ok,
    reason: result.ok ? null : result.reason,
    delivery_id: env.deliveryId,
  });
  return { opportunityId, resolved: result.ok };
}

async function handleAmbiguous(
  env: WhaapyPostventaInboundEnvelope,
  contactId: UUID,
  active: OpportunityRow[],
): Promise<void> {
  const candidateIds = active.map((o) => o.id);
  await audit(null, "postventa_whaapy_inbound_needs_manual_review", {
    contact_id: contactId,
    candidate_ids: candidateIds,
    count: active.length,
    delivery_id: env.deliveryId,
  });

  // Aviso best-effort a Customer Success para que resuelva el correcto en la
  // plataforma (M4v2). Si falla o no hay resolver configurado, el audit ya
  // dejó la señal — no bloquea.
  try {
    const resolverUserId = await resolvePostventaResolverUserId(env.organizationId);
    if (resolverUserId) {
      await createNotification({
        user_id: resolverUserId,
        notification_type: "postventa_manual_review",
        origin: "system",
        origin_reference: { candidate_ids: candidateIds, delivery_id: env.deliveryId },
        opportunity_id: null,
        contact_id: contactId,
        title: "Resolución de caso ambigua (Whaapy)",
        message:
          `Whaapy marcó un caso como resuelto, pero el contacto tiene ${active.length} casos ` +
          `activos en “Caso problemático”. Resolvé el correcto manualmente en la plataforma.`,
        amount_at_stake: null,
        due_at: null,
        status: "pending",
        snoozed_until: null,
        schema_version: "1",
        completed_at: null,
      });
    }
  } catch {
    // no bloquear — el audit es la señal confiable
  }
}

async function audit(
  opportunityId: UUID | null,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await recordAuditEvent({
    actorUserId: null,
    eventType,
    entityType: opportunityId ? "opportunity" : null,
    entityId: opportunityId,
    payload: payload as Json,
  });
}

export const whaapyPostventaInboundFunctions = [whaapyPostventaInbound];
