import { z } from "zod";

/**
 * Contrato del payload de creación de lead por webhook (0038, Bloque B).
 * Fuente única de verdad de la forma que aceptan las fuentes externas
 * (formularios de la web, landings, Zapier/Make). El documento legible
 * para el cliente (Bloque D) describe exactamente estos campos.
 *
 * Módulo puro (Zod): testeable sin BD; consumido por el endpoint y el doc.
 *
 * Obligatorios: name, phone. Opcionales: email, address, external_id, message.
 *   - `address` acepta un string simple (una línea) o un objeto con campos
 *     estructurados — lo que sea más fácil para el generador de formularios.
 *   - `external_id` (opcional) sirve como clave de idempotencia/dedup y
 *     para atribución fina; si falta, el endpoint dedupea por hash del body.
 *   - `message` (opcional): texto libre que escribió el visitante; aterriza en
 *     la nota de la oportunidad y en la historia del contacto.
 */

const addressObjectSchema = z
  .object({
    address1: z.string().max(200).optional(),
    address2: z.string().max(200).optional(),
    city: z.string().max(200).optional(),
    province: z.string().max(200).optional(), // estado / provincia
    country: z.string().max(200).optional(),
    zip: z.string().max(200).optional(),
  })
  .strip();

export const leadWebhookPayloadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(1).max(40),
  email: z.string().trim().email().max(200).optional().nullable(),
  address: z.union([z.string().max(500), addressObjectSchema]).optional().nullable(),
  external_id: z.string().trim().max(200).optional().nullable(),
  message: z.string().trim().max(2000).optional().nullable(),
});

export interface ParsedLeadPayload {
  fullName: string;
  phone: string;
  email: string | null;
  address: Record<string, string> | null;
  externalId: string | null;
  /** Mensaje libre que escribió el visitante en el formulario (opcional). */
  message: string | null;
}

/**
 * Valida + normaliza el payload crudo. Lanza `ZodError` si es inválido
 * (el endpoint lo mapea a 422 con detalle). El `address` string se mapea a
 * `{ address1 }`; el objeto se limpia de campos vacíos.
 */
export function parseLeadWebhookPayload(raw: unknown): ParsedLeadPayload {
  const p = leadWebhookPayloadSchema.parse(raw);

  let address: Record<string, string> | null = null;
  if (typeof p.address === "string") {
    const t = p.address.trim();
    address = t ? { address1: t } : null;
  } else if (p.address && typeof p.address === "object") {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.address)) {
      if (typeof v === "string" && v.trim()) cleaned[k] = v.trim();
    }
    address = Object.keys(cleaned).length > 0 ? cleaned : null;
  }

  return {
    fullName: p.name.trim(),
    phone: p.phone.trim(),
    email: p.email ? p.email.trim().toLowerCase() : null,
    address,
    externalId: p.external_id ? p.external_id.trim() : null,
    message: p.message ? p.message.trim() : null,
  };
}
