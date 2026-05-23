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
 * Estructura REAL del payload Whaapy (validada contra captura del
 * webhook entregado por Whaapy y la doc pública
 * /api-reference/webhooks/payloads):
 *
 *   {
 *     "event": "contact.created",
 *     "timestamp": "2026-05-22T23:28:04.685Z",
 *     "businessId": "1db0bff4-...",
 *     "data": { "name": "...", "contact_id": "...", "phone_number": "...", ... }
 *   }
 *
 * `businessId` vive a NIVEL ROOT, no anidado dentro de `data`. El
 * identificador del contacto en eventos `contact.*` se llama
 * `contact_id` dentro de `data` (no `id`). Eventos `conversation.*`
 * usan `data.id` para el id de la conversación y `data.contact_id`
 * para referenciar al contacto.
 *
 * NOTA payload `contact.updated`: Whaapy solo emite delta —
 * `updated_fields`, `name`, `previous_name`, `updated_by`. El worker
 * hace GET /contacts/v1/{id} para reconciliar snapshot completo
 * ANTES de aplicar LWW por campo.
 */

// ============================================================
// Envelope común — todos los webhooks
// ============================================================

// `.nullish()` (no `.nullable()`) — Whaapy omite `address` cuando el
// contacto no tiene dirección cargada (no manda `null` explícito ni
// objeto vacío). Validado contra payload real `contact.created`
// capturado en producción 2026-05-22 — el campo `address` no aparece
// en el JSON cuando el contacto se crea solo con nombre + teléfono.
// Ver entrada en ERRORES.md "Schemas Zod inbound Whaapy intolerantes
// a omisiones de campos opcionales".
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
  .nullish();

const WhaapyCustomFieldsSchema = z
  .record(z.string(), z.unknown())
  .nullish();

// ============================================================
// contact.created
// ============================================================

export const WhaapyContactCreatedPayloadSchema = z
  .object({
    event: z.literal("contact.created").optional(),
    businessId: z.string(),
    timestamp: z.string().nullish(),
    data: z
      .object({
        contact_id: z.string(),
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
    businessId: z.string(),
    timestamp: z.string().nullish(),
    data: z
      .object({
        contact_id: z.string(),
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
    businessId: z.string(),
    timestamp: z.string().nullish(),
    data: z
      .object({
        contact_id: z.string(),
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
    businessId: z.string(),
    timestamp: z.string().nullish(),
    data: z
      .object({
        id: z.string(),
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
    businessId: z.string(),
    timestamp: z.string().nullish(),
    data: z
      .object({
        id: z.string(),
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
    businessId: z.string(),
    timestamp: z.string().nullish(),
    data: z
      .object({
        id: z.string(),
        contact_id: z.string(),
        unassigned_at: z.string().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

export const WhaapyConversationClosedPayloadSchema = z
  .object({
    event: z.literal("conversation.closed").optional(),
    businessId: z.string(),
    timestamp: z.string().nullish(),
    data: z
      .object({
        id: z.string(),
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
 *
 * Path real: ROOT del payload (NO `data.businessId`). Ver entrada
 * en ERRORES.md "businessId de Whaapy vive en root del payload, no
 * dentro de data".
 */
export function extractBusinessId(payload: Json): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, Json>;
  const id = obj.businessId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Extrae el topic del payload — fallback cuando Whaapy no lo envíe
 * en header. Esperado en `event` o `topic` (root level).
 */
export function extractTopic(payload: Json): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, Json>;
  const ev = obj.event ?? obj.topic;
  return typeof ev === "string" && ev.length > 0 ? ev : null;
}

/**
 * Extrae el timestamp del payload Whaapy si está presente (root
 * level). Permite usar la marca temporal del proveedor en lugar de
 * `new Date()` cuando convenga para trazabilidad.
 */
export function extractTimestamp(payload: Json): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, Json>;
  const ts = obj.timestamp;
  return typeof ts === "string" && ts.length > 0 ? ts : null;
}
