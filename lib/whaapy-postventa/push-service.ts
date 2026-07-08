import "server-only";
import { getOpportunityById } from "@/lib/db/opportunities";
import { getContactById } from "@/lib/db/contacts";
import { recordAuditEvent } from "@/lib/db/operational";
import { normalizePhone } from "@/lib/services/identity-matching";
import {
  findPostventaContactByPhone,
  movePostventaContactToStage,
  patchPostventaContactCustomFields,
  resolvePostventaStageIdByKey,
} from "@/lib/whaapy-postventa/api";
import {
  WHAAPY_POSTVENTA_CUSTOM_FIELDS,
  type WhaapyPostventaStageKey,
} from "@/lib/whaapy-postventa/config";
import type { Json, UUID } from "@/lib/types/database";

/**
 * Servicio de PUSH de etapa al Whaapy de Post-venta (webhooks 1, 2, 4).
 *
 * Orquesta: opp → contacto (teléfono) → match en Whaapy por teléfono →
 * escribir contexto del pedido en custom_fields → mover de etapa (lo que
 * dispara la automatización interna de Whaapy).
 *
 * Contrato de errores (importante para la semántica del worker):
 *   - Casos "no aplica" (opp inexistente, sin teléfono, sin match en
 *     Whaapy, etapa no resuelta) NO lanzan — auditan y devuelven un
 *     `skipped`. Son estados esperados (decisión aprobada: "registrar y no
 *     romper"), reintentar no ayuda.
 *   - Fallos de red/HTTP de Whaapy (429/5xx/4xx) SÍ lanzan `WhaapyApiError`
 *     → el worker de Inngest reintenta con backoff → DLQ tras agotar.
 *
 * Anti-bucle capa 2 (outbound): si el contacto YA está en la etapa destino
 * en Whaapy, se salta el move — así no se re-dispara `contact.stage_changed`.
 */

export type PostventaPushResult =
  | { ok: true; moved: boolean; whaapyContactId: string }
  | { ok: false; skipped: PostventaPushSkipReason };

export type PostventaPushSkipReason =
  | "opportunity_not_found"
  | "contact_not_found"
  | "missing_phone"
  | "stage_unresolved"
  | "no_whaapy_match";

export interface PushPostventaStageInput {
  organizationId: UUID;
  opportunityId: UUID;
  target: WhaapyPostventaStageKey;
}

export async function pushPostventaStage(
  input: PushPostventaStageInput,
): Promise<PostventaPushResult> {
  const { organizationId, opportunityId, target } = input;

  const opp = await getOpportunityById(opportunityId);
  if (!opp) {
    await audit(opportunityId, "postventa_whaapy_push_skipped", {
      target,
      reason: "opportunity_not_found",
    });
    return { ok: false, skipped: "opportunity_not_found" };
  }

  const contact = opp.contact_id ? await getContactById(opp.contact_id) : null;
  if (!contact) {
    await audit(opportunityId, "postventa_whaapy_push_skipped", {
      target,
      reason: "contact_not_found",
    });
    return { ok: false, skipped: "contact_not_found" };
  }

  const phone = normalizePhone(contact.phone);
  if (!phone) {
    await audit(opportunityId, "postventa_whaapy_push_skipped", {
      target,
      reason: "missing_phone",
    });
    return { ok: false, skipped: "missing_phone" };
  }

  // Resolver el UUID de la etapa destino en Whaapy (por nombre, cacheado).
  const stageId = await resolvePostventaStageIdByKey(organizationId, target);
  if (!stageId) {
    // Config: la etapa esperada no existe con ese nombre en Whaapy.
    await audit(opportunityId, "postventa_whaapy_stage_unresolved", {
      target,
    });
    return { ok: false, skipped: "stage_unresolved" };
  }

  // Match por teléfono. Sin match → registrar y no romper (decisión aprobada).
  const match = await findPostventaContactByPhone(organizationId, phone);
  if (!match) {
    await audit(opportunityId, "postventa_whaapy_no_match", {
      target,
      stage_id: stageId,
    });
    return { ok: false, skipped: "no_whaapy_match" };
  }

  // Escribir contexto del pedido en custom_fields (match inverso + template).
  await patchPostventaContactCustomFields(organizationId, match.contactId, {
    [WHAAPY_POSTVENTA_CUSTOM_FIELDS.opportunityId]: opportunityId,
    [WHAAPY_POSTVENTA_CUSTOM_FIELDS.orderRef]: opp.display_reference ?? null,
    [WHAAPY_POSTVENTA_CUSTOM_FIELDS.orderId]: opp.shopify_order_id ?? null,
  });

  // Anti-bucle capa 2: si ya está en la etapa destino, no re-mover.
  if (match.currentStageId === stageId) {
    await audit(opportunityId, "postventa_whaapy_already_in_stage", {
      target,
      stage_id: stageId,
      whaapy_contact_id: match.contactId,
    });
    return { ok: true, moved: false, whaapyContactId: match.contactId };
  }

  await movePostventaContactToStage(organizationId, match.contactId, stageId);
  await audit(opportunityId, "postventa_whaapy_stage_pushed", {
    target,
    stage_id: stageId,
    whaapy_contact_id: match.contactId,
    order_ref: opp.display_reference ?? null,
  });
  return { ok: true, moved: true, whaapyContactId: match.contactId };
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
