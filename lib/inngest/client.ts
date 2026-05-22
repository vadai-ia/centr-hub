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
  reason: "create_from_shopify" | "update_from_shopify";
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
 * Envelope inbound Whaapy → workers.
 *
 * Construido por `/api/webhooks/whaapy` después de verificar HMAC,
 * resolver tenant por `data.businessId` y deduplicar `X-Webhook-ID`.
 * Los workers castean `event.data` a este tipo.
 */
export interface WhaapyWebhookEnvelope {
  organizationId: UUID;
  whaapyBusinessId: string;
  /** X-Webhook-ID — dedup atómico + trazabilidad. */
  eventId: string;
  /** Topic exacto del payload (ej. "contact.created", "conversation.assigned"). */
  topic: string;
  /** Timestamp de entrega del webhook si Whaapy lo expone. */
  receivedAt: string;
  payload: Json;
}

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
