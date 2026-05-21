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
