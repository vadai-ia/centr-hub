import "server-only";
import { getOpportunityById } from "@/lib/db/opportunities";
import { getContactById, updateContact } from "@/lib/db/contacts";
import { recordAuditEvent } from "@/lib/db/operational";
import { normalizePhone } from "@/lib/services/identity-matching";
import {
  findVentaContactByPhone,
  getVentaContactStageId,
  moveVentaContactToStage,
  patchVentaContactCustomFields,
  resolveVentaStageIdByKey,
} from "@/lib/whaapy/funnel";
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
 * A quién mover: `contacts.whaapy_contact_id` cuando está poblado y, si no,
 * búsqueda por teléfono en esa instancia (con backfill del id local). En
 * producción solo el 13% de los contactos trae el id, así que el rescate NO
 * es un caso borde: es el camino habitual.
 *
 * Contrato de errores, igual que `pushPostventaStage`:
 *   - Casos "no aplica" (sin contacto, sin teléfono, contacto ausente en
 *     Whaapy, etapa inexistente) NO lanzan: auditan y devuelven `skipped`
 *     con el motivo exacto. Reintentar no ayuda.
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
  | "missing_phone"
  | "contact_not_in_whaapy"
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

  const stageId = await resolveVentaStageIdByKey(organizationId, "entregado");
  if (!stageId) {
    // Configuración pendiente: la etapa no existe en el funnel de Venta.
    await audit(opportunityId, "venta_delivery_stage_unresolved", {
      contact_id: contact.id,
    });
    return { ok: false, skipped: "stage_unresolved" };
  }

  // Resolver a quién mover. `whaapy_contact_id` solo está poblado en ~13% de
  // los contactos, así que el camino normal es el rescate por teléfono.
  const resolved = await resolveVentaContact(organizationId, contact, opportunityId);
  if (!resolved.ok) return { ok: false, skipped: resolved.reason };
  const { contactId: whaapyContactId, currentStageId } = resolved;

  // Anti-duplicado ANTES de escribir: si ya está en la etapa, ni siquiera
  // vale la pena tocar los custom_fields (ese PATCH rebotaría por webhook).
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

  // Sin el `#`: la plantilla aprobada ya lo trae en su texto fijo
  // ("tu pedido #{{2}} ha sido entregado"), así que mandar "#1759" saldría
  // como "pedido ##1759".
  await patchVentaContactCustomFields(organizationId, whaapyContactId, {
    centrhub_order_ref: toTemplateOrderParam(orderRef),
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

/**
 * Resuelve el contacto en el Whaapy de Venta, por dos vías:
 *
 *  1. `contacts.whaapy_contact_id` si está poblado (cuesta un GET para saber
 *     su etapa actual).
 *  2. Si no, búsqueda por teléfono — que además devuelve la etapa, así que
 *     el camino de rescate cuesta UNA llamada, no dos. Al encontrarlo se
 *     **backfillea el id local**: la próxima entrega de ese cliente ya no
 *     paga la búsqueda, y el resto del sistema hereda la identidad enlazada.
 *
 * Devuelve null (con audit) cuando no hay teléfono o el contacto no existe
 * del otro lado. NO lo crea: Venta es la base conversacional maestra y su
 * creación la gobiernan las reglas de sincronización asimétrica, no un
 * mensaje de entrega.
 */
type ResolvedVentaContact =
  | { ok: true; contactId: string; currentStageId: string | null }
  | { ok: false; reason: VentaDeliveryPushSkipReason };

async function resolveVentaContact(
  organizationId: UUID,
  contact: { id: UUID; phone: string | null; whaapy_contact_id: string | null },
  opportunityId: UUID,
): Promise<ResolvedVentaContact> {
  if (contact.whaapy_contact_id) {
    const currentStageId = await getVentaContactStageId(
      organizationId,
      contact.whaapy_contact_id,
    );
    return { ok: true, contactId: contact.whaapy_contact_id, currentStageId };
  }

  const phone = normalizePhone(contact.phone);
  if (!phone) {
    await audit(opportunityId, "venta_delivery_push_skipped", {
      reason: "missing_phone",
      contact_id: contact.id,
    });
    return { ok: false, reason: "missing_phone" };
  }

  const match = await findVentaContactByPhone(organizationId, phone);
  if (!match) {
    await audit(opportunityId, "venta_delivery_contact_not_in_whaapy", {
      contact_id: contact.id,
    });
    return { ok: false, reason: "contact_not_in_whaapy" };
  }

  await updateContact(contact.id, { whaapy_contact_id: match.contactId });
  await audit(opportunityId, "venta_delivery_contact_linked_by_phone", {
    contact_id: contact.id,
    whaapy_contact_id: match.contactId,
  });
  return { ok: true, ...match };
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
