import "server-only";
import { DateTime } from "luxon";
import { getOpportunityById, updateOpportunity } from "@/lib/db/opportunities";
import { getTenantScopedClient } from "@/lib/db/client";
import { recordAuditEvent } from "@/lib/db/operational";
import { pushPostventaStage } from "@/lib/whaapy-postventa/push-service";
import { POSTVENTA_FOLLOWUP_DELAY_DAYS } from "@/lib/whaapy-postventa/config";
import { resolvePostventaStages } from "@/lib/services/dashboard-stages";
import { moveOpportunityStage } from "@/lib/services/pipeline-move";
import type { Json, UUID } from "@/lib/types/database";

/**
 * MENSAJE 2 — seguimiento "7 dias", desde el número de POST-VENTA.
 *
 * Sale 7 días después del ENVÍO del mensaje 1 (no de la fecha de entrega):
 * ese es el instante que la plataforma controla y selló en
 * `delivery_message_sent_at`.
 *
 * Al dispararlo, la opp avanza a "Seguimiento post-entrega" en el pipeline
 * — así "Entregado" queda poblada la semana que dura el ciclo real, en vez
 * de vaciarse al instante.
 *
 * ## Por qué las guardas de elegibilidad no son opcionales
 *
 * El texto pregunta "¿todo funciona correctamente y cumple con tus
 * expectativas?". Mandárselo a alguien cuyo pedido se canceló, se reembolsó
 * o acabó en un caso problemático no es un detalle cosmético: es el peor
 * mensaje posible en el peor momento. Por eso se excluyen explícitamente
 * canceladas, casos resueltos y cualquier opp que esté en la etapa de caso
 * problemático — aunque su mensaje 1 haya salido bien días antes.
 *
 * Es además categoría MARKETING en Meta: duplicarlo cuesta reputación del
 * número, no solo dinero. La idempotencia vive en
 * `followup_message_sent_at` (0049) y se sella ANTES de considerar el envío
 * exitoso.
 */

export type FollowupResult =
  | { ok: true; sent: true }
  | { ok: true; sent: false; reason: FollowupSkipReason }
  | { ok: false; reason: "push_failed" };

export type FollowupSkipReason =
  | "opportunity_not_found"
  | "already_sent"
  | "delivery_message_not_sent"
  | "not_due_yet"
  | "cancelled"
  | "resolved"
  | "problem_case";

/**
 * Ids de las opps que YA cumplieron los 7 días y siguen pendientes del
 * mensaje 2. Filtra en SQL lo que se puede (el índice parcial de 0049) y
 * deja las guardas de etapa para el servicio, que necesita las etapas
 * resueltas de la org.
 */
export async function listOpportunitiesDueForFollowup(
  nowIso: string = new Date().toISOString(),
): Promise<UUID[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const cutoff = DateTime.fromISO(nowIso, { zone: "utc" })
    .minus({ days: POSTVENTA_FOLLOWUP_DELAY_DAYS })
    .toISO()!;
  const { data, error } = await supabase
    .from("opportunities")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("funnel", "post_venta")
    .is("followup_message_sent_at", null)
    .is("cancelled_at", null)
    .is("resolved_at", null)
    .not("delivery_message_sent_at", "is", null)
    .lte("delivery_message_sent_at", cutoff)
    .limit(500);
  if (error) throw error;
  return (data ?? []).map((r) => r.id as UUID);
}

export async function sendPostventaFollowup(input: {
  organizationId: UUID;
  opportunityId: UUID;
  nowIso?: string;
}): Promise<FollowupResult> {
  const { organizationId, opportunityId } = input;
  const nowIso = input.nowIso ?? new Date().toISOString();

  const opp = await getOpportunityById(opportunityId);
  if (!opp) return skip(opportunityId, "opportunity_not_found");

  // Idempotencia primero: barata y es la que protege al cliente.
  if (opp.followup_message_sent_at) return skip(opportunityId, "already_sent");
  if (!opp.delivery_message_sent_at) {
    return skip(opportunityId, "delivery_message_not_sent");
  }
  if (opp.cancelled_at) return skip(opportunityId, "cancelled");
  if (opp.resolved_at) return skip(opportunityId, "resolved");

  const due = DateTime.fromISO(opp.delivery_message_sent_at).plus({
    days: POSTVENTA_FOLLOWUP_DELAY_DAYS,
  });
  if (DateTime.fromISO(nowIso) < due) return skip(opportunityId, "not_due_yet");

  const stages = await resolvePostventaStages();
  // "¿Todo funciona correctamente?" a alguien con un caso abierto es el peor
  // mensaje posible. Se comprueba por etapa ACTUAL, no por el historial: lo
  // que importa es cómo está hoy, no cómo estaba al entregarse.
  if (stages.problematicStage && opp.stage_id === stages.problematicStage.id) {
    return skip(opportunityId, "problem_case");
  }

  // El push a Whaapy dispara la Automation de esa instancia → el mensaje.
  const push = await pushPostventaStage({
    organizationId,
    opportunityId,
    target: "seguimiento",
  });
  if (!push.ok) {
    await audit(opportunityId, "postventa_followup_push_skipped", {
      reason: push.skipped,
    });
    return { ok: false, reason: "push_failed" };
  }

  // Sellar ANTES de mover la etapa: si el move fallara, el cliente ya
  // recibió el mensaje y reintentar se lo mandaría dos veces.
  await updateOpportunity(opportunityId, { followup_message_sent_at: nowIso });

  const seguimiento = stages.followupStage;
  if (seguimiento && opp.stage_id !== seguimiento.id) {
    await moveOpportunityStage({
      opportunityId,
      toStageId: seguimiento.id as UUID,
      actorUserId: null,
      context: "automation",
      expectedLastModifiedAt: opp.last_modified_at,
    });
  }

  await audit(opportunityId, "postventa_followup_message_sent", {
    whaapy_contact_id: push.whaapyContactId,
    moved_stage: Boolean(seguimiento && opp.stage_id !== seguimiento.id),
    delivery_message_sent_at: opp.delivery_message_sent_at,
  });
  return { ok: true, sent: true };
}

async function skip(
  opportunityId: UUID,
  reason: FollowupSkipReason,
): Promise<FollowupResult> {
  // `not_due_yet` y `already_sent` son el caso normal de cada tick del cron:
  // auditarlos inundaría el log sin aportar nada.
  if (reason !== "not_due_yet" && reason !== "already_sent") {
    await audit(opportunityId, "postventa_followup_skipped", { reason });
  }
  return { ok: true, sent: false, reason };
}

async function audit(
  opportunityId: UUID,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await recordAuditEvent({
    actorUserId: null,
    eventType,
    entityType: "opportunity",
    entityId: opportunityId,
    payload: payload as Json,
  });
}
