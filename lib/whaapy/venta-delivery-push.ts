import "server-only";
import { getOpportunityById } from "@/lib/db/opportunities";
import { getContactById } from "@/lib/db/contacts";
import { recordAuditEvent } from "@/lib/db/operational";
import {
  getVentaContactStageId,
  moveVentaContactToStage,
  patchVentaContactCustomFields,
  resolveVentaStageIdByKey,
} from "@/lib/whaapy/funnel";
import { resolveCustomerFacingOrderRef } from "@/lib/services/order-reference";
import type { Json, UUID } from "@/lib/types/database";

/**
 * MENSAJE 1 de Post-venta — confirmación de entrega, enviado desde el
 * número de VENTAS.
 *
 * Flujo completo:
 *   opp entra a "Entregado" en el pipeline de Post-venta de la plataforma
 *     → este servicio escribe el nº de pedido en el contacto de Venta
 *     → y lo mueve a la etapa "Entregado" del funnel de Venta
 *       → la Automation de Whaapy (Venta) dispara `send_template`
 *         → el cliente recibe el mensaje DESDE EL NÚMERO DE VENTAS
 *
 * Por qué desde Venta y no desde Post-venta: es el número con el que el
 * cliente cotizó, y la plantilla está aprobada en esa WABA. El mensaje de
 * seguimiento a 7 días sí sale del número de Post-venta — van separados a
 * propósito (decisión del operador).
 *
 * Contrato de errores, igual que `pushPostventaStage`:
 *   - Casos "no aplica" (sin contacto, sin id de Whaapy, etapa inexistente)
 *     NO lanzan: auditan y devuelven `skipped`. Reintentar no ayuda.
 *   - Fallos de red/HTTP de Whaapy SÍ lanzan → Inngest reintenta → DLQ. La
 *     opp ya movió antes de encolar, así que la operación de plataforma
 *     nunca se rompe por esto.
 *
 * Anti-duplicado: si el contacto YA está en "Entregado" no se re-mueve. El
 * trigger de Whaapy es ENTRAR a la etapa; un move redundante le mandaría el
 * mensaje al cliente por segunda vez.
 */

export type VentaDeliveryPushResult =
  | { ok: true; moved: boolean; whaapyContactId: string }
  | { ok: false; skipped: VentaDeliveryPushSkipReason };

export type VentaDeliveryPushSkipReason =
  | "opportunity_not_found"
  | "contact_not_found"
  | "missing_whaapy_contact_id"
  | "stage_unresolved";

export async function pushVentaDeliveryMessage(input: {
  organizationId: UUID;
  opportunityId: UUID;
}): Promise<VentaDeliveryPushResult> {
  const { organizationId, opportunityId } = input;

  const opp = await getOpportunityById(opportunityId);
  if (!opp) {
    await audit(opportunityId, "venta_delivery_push_skipped", {
      reason: "opportunity_not_found",
    });
    return { ok: false, skipped: "opportunity_not_found" };
  }

  const contact = opp.contact_id ? await getContactById(opp.contact_id) : null;
  if (!contact) {
    await audit(opportunityId, "venta_delivery_push_skipped", {
      reason: "contact_not_found",
    });
    return { ok: false, skipped: "contact_not_found" };
  }

  // Venta es la instancia MAESTRA: su contact_id ya vive en la BD local, no
  // hace falta buscar por teléfono. Sin él, el contacto nunca se sincronizó
  // hacia allá y no hay a quién mover.
  const whaapyContactId = contact.whaapy_contact_id;
  if (!whaapyContactId) {
    await audit(opportunityId, "venta_delivery_push_skipped", {
      reason: "missing_whaapy_contact_id",
      contact_id: contact.id,
    });
    return { ok: false, skipped: "missing_whaapy_contact_id" };
  }

  const stageId = await resolveVentaStageIdByKey(organizationId, "entregado");
  if (!stageId) {
    // Configuración pendiente: la etapa no existe en el funnel de Venta.
    await audit(opportunityId, "venta_delivery_stage_unresolved", {
      contact_id: contact.id,
    });
    return { ok: false, skipped: "stage_unresolved" };
  }

  // Anti-duplicado ANTES de escribir: si ya está en la etapa, ni siquiera
  // vale la pena tocar los custom_fields (ese PATCH rebotaría por webhook).
  const currentStageId = await getVentaContactStageId(organizationId, whaapyContactId);
  if (currentStageId === stageId) {
    await audit(opportunityId, "venta_delivery_already_in_stage", {
      whaapy_contact_id: whaapyContactId,
      stage_id: stageId,
    });
    return { ok: true, moved: false, whaapyContactId };
  }

  // El nº que el cliente conoce (#1759), NUNCA el del borrador (#D903).
  const orderRef = await resolveCustomerFacingOrderRef(opp.shopify_order_id);
  if (!orderRef) {
    await audit(opportunityId, "venta_delivery_order_ref_missing", {
      shopify_order_id: opp.shopify_order_id ?? null,
      display_reference: opp.display_reference ?? null,
    });
  }

  await patchVentaContactCustomFields(organizationId, whaapyContactId, {
    centrhub_order_ref: orderRef,
    centrhub_opportunity_id: opportunityId,
  });

  await moveVentaContactToStage(organizationId, whaapyContactId, stageId);
  await audit(opportunityId, "venta_delivery_message_pushed", {
    whaapy_contact_id: whaapyContactId,
    stage_id: stageId,
    order_ref: orderRef,
  });
  return { ok: true, moved: true, whaapyContactId };
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
