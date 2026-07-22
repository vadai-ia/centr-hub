import "server-only";
import { Inngest } from "inngest";
import type { UUID, Json } from "@/lib/types/database";

/**
 * Cliente Inngest (Sección 3.1). Singleton.
 *
 * El envelope de webhooks Shopify viaja en `event.data` de cada
 * función registrada. Los workers castean `event.data` a
 * `ShopifyWebhookEnvelope`. El runtime ya valida estructura porque
 * el productor único (endpoint `/api/webhooks/shopify`) construye
 * el envelope antes de invocar `inngest.send`.
 *
 * Nota: la SDK v4 quitó `EventSchemas`. Los schemas se aplican
 * por-trigger con `schema:` (StandardSchemaV1). En este proyecto
 * el cast manual es suficiente porque hay un productor único.
 */

export interface ShopifyWebhookEnvelope {
  organizationId: UUID;
  shopDomain: string;
  /** X-Shopify-Webhook-Id — dedup atómico + trazabilidad. */
  eventId: string;
  /** Topic exacto enviado por Shopify (ej. "orders/paid"). */
  topic: string;
  /** Timestamp de entrega de Shopify (X-Shopify-Triggered-At) — opcional. */
  triggeredAt: string | null;
  /** Payload JSON entrante (ya validado HMAC). */
  payload: Json;
}

export interface OutboundRetryEnvelope {
  organizationId: UUID;
  shopifyCustomerId: string | null;
  contactId: UUID;
  operation: "update_customer" | "add_tag" | "remove_tag" | "create_customer";
  attempt: number;
  payload: Json;
}

/**
 * Envelope para sincronización outbound Shopify → Whaapy
 * (asimetría v5.1 + Ajuste post-Discovery 2 #14).
 *
 * Emitido por workers de M3 (customers/create y customers/update)
 * cuando un cambio del lado Shopify debe propagarse a Whaapy.
 * Consumido por M4 cuando se registre su worker. Si M4 no existe
 * todavía cuando M3 está deployado, la cola Inngest acumula
 * eventos y los drena al registrarse — sin backfill manual.
 *
 * El snapshot completo del contacto viaja en el evento para que
 * M4 procese aunque el contact local cambie después. LWW se
 * reconcilia al aplicar el outbound (M4 compara timestamps).
 */
export interface WhaapyContactSyncEnvelope {
  organizationId: UUID;
  contactId: UUID;
  /**
   * Disparadores admitidos por el worker `whaapyOutboundContactSync`:
   *   - `create_from_shopify`     — sync inicial cuando Shopify crea un
   *     customer y no existe contraparte Whaapy (Sección 3.6).
   *   - `update_from_shopify`     — Shopify cambió un customer enlazado
   *     y propagamos campos actualizables a Whaapy.
   *   - `update_from_platform_ui` — edición o reasignación manual del
   *     contacto desde Centr Hub (M6 — B7/B8). Mismo flujo de PATCH
   *     que `update_from_shopify`, pero el motivo del audit diferencia
   *     el origen y deja claro que NO es eco de Shopify.
   *   - `create_from_platform_ui` — lead nacido en la plataforma
   *     (creación manual o por webhook) que debe crearse en el Whaapy de
   *     Venta con su asesor. Mismo flujo de POST/409 que `create_from_shopify`;
   *     `assigned_agent_id` viaja si el asesor mapea a un whaapy_agent_id.
   */
  reason:
    | "create_from_shopify"
    | "update_from_shopify"
    | "update_from_platform_ui"
    | "create_from_platform_ui";
  contactSnapshot: {
    shopifyCustomerId: string | null;
    whaapyContactId: string | null;
    fullName: string | null;
    email: string | null;
    phone: string | null;
    address: Json | null;
    internalNote: string | null;
    shopifyTags: string[];
    shopifyState: string | null;
    assignedAdvisorId: UUID | null;
    fieldMetadata: Json;
    lastModifiedAt: string;
    lastModifiedSource: string;
  };
}

export const WHAAPY_OUTBOUND_CONTACT_SYNC_EVENT = "whaapy/outbound.contact_sync_requested" as const;

/**
 * Envelope para propagación outbound Shopify desde edición manual
 * del contacto en la plataforma (M6 — B8).
 *
 * El worker consume el snapshot completo del contact y llama a
 * `updateCustomer` con los campos editables. R11 (defensa anti-bucle)
 * se aplica dentro de `updateCustomer` vía `markOutboundWrite` ANTES
 * del PUT — el webhook eco subsiguiente de Shopify se descarta por
 * `discardIfOwnEcho`. Sin necesidad de un evento separado por campo:
 * si el caller emite cambios > una vez, Inngest dedup natural lo
 * consolida (el último gana en LWW).
 */
export interface ShopifyContactUpdateEnvelope {
  organizationId: UUID;
  contactId: UUID;
  reason: "update_from_platform_ui";
  contactSnapshot: {
    shopifyCustomerId: string;
    fullName: string | null;
    email: string | null;
    phone: string | null;
    address: Json | null;
    internalNote: string | null;
  };
}

export const SHOPIFY_OUTBOUND_CONTACT_UPDATE_EVENT = "shopify/outbound.contact_update_requested" as const;

/**
 * Envelope inbound Whaapy → workers.
 *
 * Construido por `/api/webhooks/whaapy` después de verificar HMAC,
 * resolver tenant por `businessId` (root del payload) y deduplicar
 * por `X-Webhook-Delivery-ID` (único por entrega — el header
 * `X-Webhook-ID` se reusa por contact_id; ver ERRORES.md).
 * Los workers castean `event.data` a este tipo.
 */
export interface WhaapyWebhookEnvelope {
  organizationId: UUID;
  whaapyBusinessId: string;
  /** X-Webhook-Delivery-ID — único por entrega, dedup + trazabilidad. */
  deliveryId: string;
  /** Topic exacto del payload (ej. "contact.created", "conversation.assigned"). */
  topic: string;
  /** Timestamp de entrega del webhook si Whaapy lo expone. */
  receivedAt: string;
  payload: Json;
}

/**
 * Envelope del PUSH de etapa al Whaapy de POST-VENTA (webhooks 1, 2, 4).
 *
 * Emitido por los hooks de la plataforma (`moveOpportunityStage`,
 * `reopenOpportunityIntoProblemCase`, `resolvePostventaCase`) SOLO cuando
 * el kill switch está ON. Consumido por `whaapyPostventaStagePush`, que
 * resuelve contacto por teléfono, escribe custom_fields y mueve de etapa
 * en el Whaapy de Post-venta. Independiente del outbound de Venta.
 */
export interface WhaapyPostventaStagePushEnvelope {
  organizationId: UUID;
  opportunityId: UUID;
  /** Clave lógica de la etapa destino (ver WHAAPY_POSTVENTA_STAGE_NAMES). */
  target: "entregado" | "casoProblematico" | "casoResuelto";
  /** Origen del disparo (traza + diagnóstico). */
  reason: string;
}

export const WHAAPY_POSTVENTA_STAGE_PUSH_EVENT =
  "whaapy/postventa.stage_push_requested" as const;

/**
 * Envelope INBOUND del Whaapy de Post-venta (webhook 3 — Option A).
 *
 * El evento `contact.stage_changed` no existe en Whaapy, así que la
 * resolución entrante llega por una Automation `http_request` (trigger
 * `pipeline_stage_entered` sobre "Caso Resuelto"). El endpoint
 * `/api/webhooks/whaapy-postventa` autentica por token compartido
 * (constant-time), resuelve tenant por `org` del body y normaliza el
 * envelope. El worker archiva la opp reusando `resolvePostventaCase`
 * (source inbound). Como el trigger YA es "Caso Resuelto", no hay filtro
 * de etapa; la idempotencia la da `resolvePostventaCase`.
 */
export interface WhaapyPostventaInboundEnvelope {
  organizationId: UUID;
  /** Id de dedup/traza (del body o generado). */
  deliveryId: string;
  receivedAt: string;
  /** opportunity_id si la automation lo pudo enviar; si no, null. */
  opportunityId: string | null;
  /** Teléfono del contacto (E.164, `{{contact.phoneNumber}}`). */
  phone: string | null;
}

export const WHAAPY_POSTVENTA_INBOUND_EVENT =
  "whaapy/postventa.stage_changed_inbound" as const;

let cached: Inngest | null = null;

export function getInngestClient(): Inngest {
  if (cached) return cached;
  cached = new Inngest({ id: "centr-hub" });
  return cached;
}

export const SHOPIFY_TOPIC_TO_INNGEST: Record<string, string> = {
  "customers/create":               "shopify/customers.create",
  "customers/update":               "shopify/customers.update",
  "customers/delete":               "shopify/customers.delete",
  "draft_orders/create":            "shopify/draft_orders.create",
  "draft_orders/update":            "shopify/draft_orders.update",
  "draft_orders/delete":            "shopify/draft_orders.delete",
  "orders/create":                  "shopify/orders.create",
  "orders/updated":                 "shopify/orders.updated",
  "orders/paid":                    "shopify/orders.paid",
  "orders/cancelled":               "shopify/orders.cancelled",
  "orders/fulfilled":               "shopify/orders.fulfilled",
  "orders/partially_fulfilled":     "shopify/orders.partially_fulfilled",
};

/** Topics que el endpoint público acepta + script de subscriptions registra. */
export const SHOPIFY_SUBSCRIBED_TOPICS = Object.keys(SHOPIFY_TOPIC_TO_INNGEST);

// ============================================================
// Whaapy — topic map + registro de webhooks (M4)
// ============================================================

export const WHAAPY_TOPIC_TO_INNGEST: Record<string, string> = {
  "contact.created":         "whaapy/contact.created",
  "contact.updated":         "whaapy/contact.updated",
  "contact.deleted":         "whaapy/contact.deleted",
  "conversation.created":    "whaapy/conversation.created",
  "conversation.assigned":   "whaapy/conversation.assigned",
  "conversation.unassigned": "whaapy/conversation.unassigned",
  "conversation.closed":     "whaapy/conversation.closed",
};

/** Topics que el endpoint público acepta + script de setup registra. */
export const WHAAPY_SUBSCRIBED_TOPICS = Object.keys(WHAAPY_TOPIC_TO_INNGEST);
