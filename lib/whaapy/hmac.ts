import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 con comparación constant-time para webhooks Whaapy
 * (M4).
 *
 * Disciplina (idéntica a la verificación Shopify, secret distinto):
 *   1. Body raw como buffer ANTES de parsear JSON.
 *   2. HMAC-SHA256(webhook_secret, body) → base64 o hex (Whaapy emite
 *      en base64 estándar; soportamos hex como fallback defensivo).
 *   3. timingSafeEqual contra header `X-Webhook-Signature`.
 *   4. Falla → 401 sin loguear body (data sensible).
 *
 * El secret vive en `organizations.vault_keys.whaapy.webhook_secret`
 * (devuelto por Whaapy al registrar el webhook vía POST /user-webhooks).
 */
export function verifyWhaapyHmac(
  rawBody: Buffer | string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || typeof signatureHeader !== "string") return false;
  if (!secret) return false;

  const expected = createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody)
    .digest();

  // Algunos providers emiten "sha256=<value>" — recortamos el prefijo
  // si está presente para tolerar ambas convenciones.
  const headerValue = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;

  let received: Buffer;
  try {
    // Detectar base64 vs hex por longitud — base64 produce 44 chars
    // (con padding) o 43 (sin), hex produce 64. Caer en base64 por
    // default (lo que Whaapy emite hoy).
    if (/^[0-9a-fA-F]{64}$/.test(headerValue)) {
      received = Buffer.from(headerValue, "hex");
    } else {
      received = Buffer.from(headerValue, "base64");
    }
  } catch {
    return false;
  }

  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
