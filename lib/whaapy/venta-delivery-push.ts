import "server-only";
import { getOpportunityById, updateOpportunity } from "@/lib/db/opportunities";
import { getContactById, updateContact } from "@/lib/db/contacts";
import { recordAuditEvent } from "@/lib/db/operational";
import { normalizePhone } from "@/lib/services/identity-matching";
import {
  sendVentaTemplate,
  VENTA_DELIVERY_TEMPLATE,
} from "@/lib/whaapy/send-template";
import {
  resolveCustomerFacingOrderRef,
  toTemplateOrderParam,
} from "@/lib/services/order-reference";
import type { Json, UUID } from "@/lib/types/database";

/**
 * MENSAJE 1 de Post-venta — confirmación de entrega, enviado desde el
 * número de VENTAS.
 *
 * Flujo completo:
 *   opp entra a "Entregado" en el pipeline de Post-venta de la plataforma
 *     → este servicio manda la plantilla por la API de VENTA, con el nombre
 *       y el nº de pedido ya resueltos
 *       → el cliente recibe el mensaje DESDE EL NÚMERO DE VENTAS
 *
 * Antes la plataforma escribía el folio en un `custom_field` y movía al
 * contacto de etapa para que una Automation mandara la plantilla. No
 * funciona: **Whaapy no resuelve campos personalizados como variables de
 * plantilla** y la Automation abortaba sin dejar rastro en la conversación
 * (ver `lib/whaapy/send-template.ts`). El envío directo elimina de paso al
 * intermediario: un fallo ahora es una excepción, no un silencio.
 *
 * Por qué desde Venta y no desde Post-venta: es el número con el que el
 * cliente cotizó, y la plantilla está aprobada en esa WABA. El mensaje de
 * seguimiento a 7 días sí sale del número de Post-venta — van separados a
 * propósito (decisión del operador).
 *
 * A quién se le manda: al TELÉFONO del contacto maestro. El envío por
 * teléfono hace innecesario el rescate por `whaapy_contact_id` que exigía
 * la vía anterior — en producción solo el 13% de los contactos traía ese id.
 *
 * Contrato de errores, igual que `pushPostventaStage`:
 *   - Casos "no aplica" (sin contacto, sin teléfono, contacto ausente en
 *     Whaapy, etapa inexistente) NO lanzan: auditan y devuelven `skipped`
 *     con el motivo exacto. Reintentar no ayuda.
 *   - Fallos de red/HTTP de Whaapy SÍ lanzan → Inngest reintenta → DLQ. La
 *     opp ya movió antes de encolar, así que la operación de plataforma
 *     nunca se rompe por esto.
 *
 * Anti-duplicado: `opportunities.delivery_message_sent_at`. Es el mismo
 * sello que ancla el mensaje de 7 días, así que una sola marca gobierna
 * "ya se le avisó a este cliente". Los reintentos de Inngest y un segundo
 * paso por "Entregado" NO vuelven a escribirle.
 */

export type VentaDeliveryPushResult =
  | { ok: true; sent: boolean }
  | { ok: false; skipped: VentaDeliveryPushSkipReason };

export type VentaDeliveryPushSkipReason =
  | "opportunity_not_found"
  | "contact_not_found"
  | "missing_phone"
  | "already_sent"
  | "order_ref_missing";

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

  // Anti-duplicado: una sola marca gobierna "ya se le avisó al cliente".
  if (opp.delivery_message_sent_at) {
    await audit(opportunityId, "venta_delivery_already_sent", {
      contact_id: contact.id,
      sent_at: opp.delivery_message_sent_at,
    });
    return { ok: true, sent: false };
  }

  const phone = normalizePhone(contact.phone);
  if (!phone) {
    await audit(opportunityId, "venta_delivery_push_skipped", {
      reason: "missing_phone",
      contact_id: contact.id,
    });
    return { ok: false, skipped: "missing_phone" };
  }

  // El nº que el cliente conoce (#1759), NUNCA el del borrador (#D903).
  // Sin él NO se manda: Meta rechaza una plantilla con un parámetro vacío, y
  // "tu pedido # ha sido entregado" sería peor que no escribir.
  const orderRef = await resolveCustomerFacingOrderRef(opp.shopify_order_id);
  const orderParam = toTemplateOrderParam(orderRef);
  if (!orderParam) {
    await audit(opportunityId, "venta_delivery_order_ref_missing", {
      shopify_order_id: opp.shopify_order_id ?? null,
      display_reference: opp.display_reference ?? null,
    });
    return { ok: false, skipped: "order_ref_missing" };
  }

  // Sin el `#`: la plantilla ya lo trae en su texto fijo ("tu pedido
  // #{{2}} ha sido entregado"), así que "#1759" saldría como "##1759".
  await sendVentaTemplate(organizationId, {
    to: phone,
    templateName: VENTA_DELIVERY_TEMPLATE,
    parameters: [firstName(contact.full_name), orderParam],
  });

  // Sello del ANCLA: el mensaje 2 ("7 dias") se cuenta desde AQUÍ, no desde
  // la fecha de entrega. Después del envío: si el POST falla, Inngest
  // reintenta y no queremos anclar un mensaje que no salió.
  await updateOpportunity(opportunityId, {
    delivery_message_sent_at: new Date().toISOString(),
  });

  await audit(opportunityId, "venta_delivery_message_sent", {
    contact_id: contact.id,
    template: VENTA_DELIVERY_TEMPLATE,
    order_ref: orderRef,
  });
  return { ok: true, sent: true };
}

/**
 * {{1}} de la plantilla. Whaapy resolvía `{{contact.first_name}}` de su
 * propia ficha; enviando nosotros, el nombre sale del contacto MAESTRO, que
 * es la fuente de verdad (O11). Vacío → saludo genérico antes que "Hola, .".
 */
function firstName(fullName: string | null): string {
  const first = (fullName ?? "").trim().split(/\s+/)[0];
  return first || "Hola";
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
