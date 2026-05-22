import "server-only";
import { z } from "zod";
import type { Json } from "@/lib/types/database";

/**
 * Mappers y schemas Zod para payloads de Whaapy (M4).
 *
 * Disciplina (espejo de `lib/shopify/mappers.ts`):
 *   - Schemas tolerantes con `.passthrough()` para no romper si
 *     Whaapy agrega campos. Validación estricta solo sobre lo que
 *     consumimos.
 *   - Mappers retornan formas internas (NormalizedX) que los
 *     workers consumen — desacopla el shape externo del modelo
 *     interno.
 *
 * NOTA payload `contact.updated`: Whaapy solo emite delta —
 * `updated_fields`, `name`, `previous_name`, `updated_by`. El worker
 * hace GET /contacts/v1/{id} para reconciliar snapshot completo
 * ANTES de aplicar LWW por campo.
 */

// ============================================================
// Envelope común — todos los webhooks
// ============================================================

const WhaapyAddressSchema = z
  .object({
    street: z.string().nullish(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    country: z.string().nullish(),
    zip: z.string().nullish(),
  })
  .passthrough()
  .partial()
  .nullable();

const WhaapyCustomFieldsSchema = z
  .record(z.string(), z.unknown())
  .nullish();

// ============================================================
// contact.created
// ============================================================

export const WhaapyContactCreatedPayloadSchema = z
  .object({
    event: z.literal("contact.created").optional(),
    data: z
      .object({
        id: z.string(),
        businessId: z.string(),
        phone_number: z.string().nullish(),
        name: z.string().nullish(),
        email: z.string().nullish(),
        wa_id: z.string().nullish(),
        source: z.string().nullish(),
        tags: z.array(z.string()).nullish(),
        assigned_agent_id: z.string().nullish(),
        custom_fields: WhaapyCustomFieldsSchema,
        address: WhaapyAddressSchema,
        created_at: z.string().nullish(),
        updated_at: z.string().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

// ============================================================
// contact.updated (DELTA — no incluye snapshot)
// ============================================================

export const WhaapyContactUpdatedPayloadSchema = z
  .object({
    event: z.literal("contact.updated").optional(),
    data: z
      .object({
        id: z.string(),
        businessId: z.string(),
        updated_fields: z.array(z.string()).default([]),
        name: z.string().nullish(),
        previous_name: z.string().nullish(),
        updated_by: z.string().nullish(),
        updated_at: z.string().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

// ============================================================
// contact.deleted
// ============================================================

export const WhaapyContactDeletedPayloadSchema = z
  .object({
    event: z.literal("contact.deleted").optional(),
    data: z
      .object({
        id: z.string(),
        businessId: z.string(),
        deleted_at: z.string().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

// ============================================================
// conversation.* — created / assigned / unassigned / closed
// ============================================================

export const WhaapyConversationCreatedPayloadSchema = z
  .object({
    event: z.literal("conversation.created").optional(),
    data: z
      .object({
        id: z.string(),
        businessId: z.string(),
        contact_id: z.string(),
        channel: z.string().nullish(),
        created_at: z.string().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

export const WhaapyConversationAssignedPayloadSchema = z
  .object({
    event: z.literal("conversation.assigned").optional(),
    data: z
      .object({
        id: z.string(),
        businessId: z.string(),
        contact_id: z.string(),
        assigned_to: z.string(),
        assigned_at: z.string().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

export const WhaapyConversationUnassignedPayloadSchema = z
  .object({
    event: z.literal("conversation.unassigned").optional(),
    data: z
      .object({
        id: z.string(),
        businessId: z.string(),
        contact_id: z.string(),
        unassigned_at: z.string().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

export const WhaapyConversationClosedPayloadSchema = z
  .object({
    event: z.literal("conversation.closed").optional(),
    data: z
      .object({
        id: z.string(),
        businessId: z.string(),
        contact_id: z.string(),
        closed_at: z.string().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

// ============================================================
// GET /contacts/v1/{id} — snapshot completo para reconciliación
// ============================================================

export const WhaapyContactGetResponseSchema = z
  .object({
    id: z.string(),
    businessId: z.string().nullish(),
    phone_number: z.string().nullish(),
    name: z.string().nullish(),
    email: z.string().nullish(),
    tags: z.array(z.string()).nullish(),
    assigned_agent_id: z.string().nullish(),
    custom_fields: WhaapyCustomFieldsSchema,
    address: WhaapyAddressSchema,
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough();

export type WhaapyContactSnapshot = z.infer<typeof WhaapyContactGetResponseSchema>;

// ============================================================
// Tenant resolution helper
// ============================================================

/**
 * Extrae `businessId` del payload. Es la única dimensión que viaja
 * en TODOS los topics y permite resolver tenant antes del HMAC
 * verify (en este flujo HMAC verify viene primero, así que esto se
 * llama después del verify exitoso).
 */
export function extractBusinessId(payload: Json): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, Json>;
  const data = obj.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const dataObj = data as Record<string, Json>;
  const id = dataObj.businessId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Extrae el topic del payload — fallback cuando Whaapy no lo envíe
 * en header. Esperado en `event` o `topic`.
 */
export function extractTopic(payload: Json): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, Json>;
  const ev = obj.event ?? obj.topic;
  return typeof ev === "string" && ev.length > 0 ? ev : null;
}
