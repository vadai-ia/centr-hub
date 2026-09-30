import "server-only";
import { DateTime } from "luxon";
import { getOpportunityById, updateOpportunity } from "@/lib/db/opportunities";
import { getTenantScopedClient } from "@/lib/db/client";
import { recordAuditEvent } from "@/lib/db/operational";
import { getContactById } from "@/lib/db/contacts";
import { normalizePhone } from "@/lib/services/identity-matching";
import { sendPostventaTemplate } from "@/lib/whaapy-postventa/send-template";
import {
  POSTVENTA_FOLLOWUP_DELAY_DAYS,
  POSTVENTA_SURVEY_TEMPLATE,
} from "@/lib/whaapy-postventa/config";
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
 *
 * ## Dos disparadores
 *
 * - `cron`: los 7 días cumplidos desde el mensaje 1. Es el flujo normal.
 * - `manual_move`: alguien arrastró la tarjeta a "Seguimiento post-entrega".
 *   Post-venta lo pidió porque es lo que ya hacían esperando que mandara la
 *   encuesta. Salta las guardas de TIEMPO (no exige mensaje 1 previo ni los
 *   7 días) — mover la tarjeta ES la decisión de mandarla — pero NO las de
 *   elegibilidad: a un caso cancelado, resuelto o problemático no se le
 *   escribe aunque lo arrastren.
 *
 * ## Por qué el envío es DIRECTO y no vía Automation
 *
 * La vía anterior movía el contacto a la etapa de Whaapy para que su
 * Automation mandara el template. Eso falla en silencio con quien YA está
 * en esa etapa (un cliente recurrente, o el que alguien movió a mano): el
 * trigger es ENTRAR, no estar. El sello quedaba puesto y el mensaje nunca
 * salía. Con el scope de mensajes ya activo, la plataforma manda el template
 * ella misma y el fallo llega como excepción.
 *
 * **Requiere que la Automation "Seguimiento 7 días" esté DESACTIVADA** en
 * Whaapy: si ambas vías estuvieran vivas, el cliente recibiría la encuesta
 * dos veces.
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
  /** Qué disparó el envío. "manual_move" salta las guardas de tiempo. */
  trigger?: "cron" | "manual_move";
}): Promise<FollowupResult> {
  const { organizationId, opportunityId } = input;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const manual = input.trigger === "manual_move";

  const opp = await getOpportunityById(opportunityId);
  if (!opp) return skip(opportunityId, "opportunity_not_found");

  // Idempotencia primero: barata y es la que protege al cliente.
  if (opp.followup_message_sent_at) return skip(opportunityId, "already_sent");
  // Las guardas de TIEMPO solo aplican al cron: en el move manual la
  // decisión ya la tomó una persona.
  if (!manual && !opp.delivery_message_sent_at) {
    return skip(opportunityId, "delivery_message_not_sent");
  }
  if (opp.cancelled_at) return skip(opportunityId, "cancelled");
  if (opp.resolved_at) return skip(opportunityId, "resolved");

  if (!manual) {
    const due = DateTime.fromISO(opp.delivery_message_sent_at!).plus({
      days: POSTVENTA_FOLLOWUP_DELAY_DAYS,
    });
    if (DateTime.fromISO(nowIso) < due) return skip(opportunityId, "not_due_yet");
  }

  const stages = await resolvePostventaStages();
  // "¿Todo funciona correctamente?" a alguien con un caso abierto es el peor
  // mensaje posible. Se comprueba por etapa ACTUAL, no por el historial: lo
  // que importa es cómo está hoy, no cómo estaba al entregarse.
  if (stages.problematicStage && opp.stage_id === stages.problematicStage.id) {
    return skip(opportunityId, "problem_case");
  }

  // La plataforma manda el template ella misma (ver cabezal): mover la
  // etapa de Whaapy no dispara nada en quien ya está en ella.
  const contact = opp.contact_id ? await getContactById(opp.contact_id) : null;
  const phone = normalizePhone(contact?.phone ?? null);
  if (!contact || !phone) {
    await audit(opportunityId, "postventa_followup_push_skipped", {
      reason: "missing_phone",
    });
    return { ok: false, reason: "push_failed" };
  }
  try {
    await sendPostventaTemplate(organizationId, {
      to: phone,
      templateName: POSTVENTA_SURVEY_TEMPLATE,
      parameters: [firstName(contact.full_name)],
    });
  } catch (error) {
    await audit(opportunityId, "postventa_followup_push_skipped", {
      reason: "send_failed",
      detail: (error as Error).message,
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
    trigger: input.trigger ?? "cron",
    moved_stage: Boolean(seguimiento && opp.stage_id !== seguimiento.id),
    delivery_message_sent_at: opp.delivery_message_sent_at,
  });
  return { ok: true, sent: true };
}

/** {{1}} del template. Vacío → saludo genérico antes que "Hola, .". */
function firstName(fullName: string | null): string {
  const first = (fullName ?? "").trim().split(/\s+/)[0];
  return first || "Hola";
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
