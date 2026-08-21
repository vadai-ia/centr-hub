import "server-only";
import { getOpportunityById } from "@/lib/db/opportunities";
import { getContactById } from "@/lib/db/contacts";
import { findOrderByShopifyOrderId } from "@/lib/db/orders";
import { recordAuditEvent } from "@/lib/db/operational";
import { normalizePhone } from "@/lib/services/identity-matching";
import {
  createPostventaContact,
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
 * (si no existe, CREAR el contacto) → escribir contexto del pedido en
 * custom_fields → mover de etapa (lo que dispara la automatización interna
 * de Whaapy).
 *
 * Auto-creación (cases 1, 2, 4): el Whaapy de Post-venta arranca vacío (la
 * base maestra vive en el Whaapy de Venta), así que sin crear el contacto
 * ausente ningún webhook funcionaría. Si el contacto no existe → se crea
 * (name + phone + email si hay + custom_fields) y LUEGO se mueve — la
 * automatización dispara igual que moviendo uno existente (siempre vía el
 * move API). Idempotente: search-first + 409 `duplicate_contact` → enlaza
 * el `existing_contact_id`, nunca duplica. Sin eco a la plataforma: no
 * suscribimos webhooks del Whaapy de Post-venta (el único inbound es la
 * Automation de "Caso Resuelto"), así que crear/mover no llama de vuelta.
 *
 * Contrato de errores (importante para la semántica del worker):
 *   - Casos "no aplica" (opp inexistente, sin teléfono, etapa no resuelta)
 *     NO lanzan — auditan y devuelven un `skipped`. Reintentar no ayuda.
 *   - Fallos de red/HTTP de Whaapy (429/5xx/4xx) SÍ lanzan `WhaapyApiError`
 *     → el worker de Inngest reintenta con backoff → DLQ tras agotar. La opp
 *     ya movió antes de encolar → operación de plataforma nunca se rompe.
 *
 * Anti-bucle capa 2 (outbound): si el contacto YA está en la etapa destino
 * en Whaapy, se salta el move — así no se re-dispara la automatización
 * (evita mensaje duplicado al cliente). Solo aplica a contactos existentes;
 * un contacto recién creado siempre se mueve.
 */

export type PostventaPushResult =
  | { ok: true; moved: boolean; created: boolean; whaapyContactId: string }
  | { ok: false; skipped: PostventaPushSkipReason };

export type PostventaPushSkipReason =
  | "opportunity_not_found"
  | "contact_not_found"
  | "missing_phone"
  | "stage_unresolved";

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

  // `orderRef` es CARA AL CLIENTE (va en la variable del template de
  // WhatsApp), así que tiene que ser el nombre del PEDIDO (#1759), no el
  // del borrador. `display_reference` guarda el del draft (#D903) y el
  // cliente nunca lo vio: su confirmación de compra dice el otro número.
  // Se resuelve desde la orden enlazada; si no hay orden, queda null antes
  // que mandar un número que el cliente no reconoce.
  const orderRef = await resolveCustomerFacingOrderRef(opp.shopify_order_id);
  const customFields = {
    [WHAAPY_POSTVENTA_CUSTOM_FIELDS.opportunityId]: opportunityId,
    [WHAAPY_POSTVENTA_CUSTOM_FIELDS.orderRef]: orderRef,
    [WHAAPY_POSTVENTA_CUSTOM_FIELDS.orderId]: opp.shopify_order_id ?? null,
  };
  if (!orderRef) {
    // Visible en el audit: la variable del template saldrá vacía.
    await audit(opportunityId, "postventa_whaapy_order_ref_missing", {
      target,
      shopify_order_id: opp.shopify_order_id ?? null,
      display_reference: opp.display_reference ?? null,
    });
  }

  // Match por teléfono. Si existe → PATCH custom_fields. Si NO existe →
  // CREAR el contacto (con custom_fields) — el Whaapy de Post-venta arranca
  // vacío, sin crearlo ningún webhook funcionaría.
  const match = await findPostventaContactByPhone(organizationId, phone);
  let contactId: string;
  let currentStageId: string | null;
  let created = false;

  if (match) {
    contactId = match.contactId;
    currentStageId = match.currentStageId;
    await patchPostventaContactCustomFields(organizationId, contactId, customFields);
  } else {
    contactId = await createPostventaContact(organizationId, {
      name: contact.full_name,
      phoneE164: phone,
      email: contact.email,
      customFields,
    });
    currentStageId = null; // recién creado (sin etapa) → siempre se mueve
    created = true;
    await audit(opportunityId, "postventa_whaapy_contact_created", {
      target,
      whaapy_contact_id: contactId,
    });
  }

  // Anti-bucle capa 2: si ya está en la etapa destino, no re-mover (evita
  // mensaje duplicado). Nunca aplica a un contacto recién creado.
  if (currentStageId === stageId) {
    await audit(opportunityId, "postventa_whaapy_already_in_stage", {
      target,
      stage_id: stageId,
      whaapy_contact_id: contactId,
    });
    return { ok: true, moved: false, created, whaapyContactId: contactId };
  }

  await movePostventaContactToStage(organizationId, contactId, stageId);
  await audit(opportunityId, "postventa_whaapy_stage_pushed", {
    target,
    stage_id: stageId,
    whaapy_contact_id: contactId,
    created,
    order_ref: orderRef,
  });
  return { ok: true, moved: true, created, whaapyContactId: contactId };
}

/**
 * Referencia del pedido tal como el CLIENTE la conoce (`#1759`), leída de
 * `orders.shopify_name`. Devuelve null si la opp no tiene orden enlazada o
 * la orden no está en la base: preferimos una variable vacía en el mensaje
 * a mandarle al cliente el número del borrador (`#D903`), que nunca vio.
 *
 * Mismo malentendido que reportó Post-venta al buscar casos por número:
 * el borrador y el pedido son identificadores distintos y solo el segundo
 * es público.
 */
async function resolveCustomerFacingOrderRef(
  shopifyOrderId: string | null,
): Promise<string | null> {
  if (!shopifyOrderId) return null;
  const order = await findOrderByShopifyOrderId(shopifyOrderId);
  const name = order?.shopify_name?.trim();
  return name && name.length > 0 ? name : null;
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
