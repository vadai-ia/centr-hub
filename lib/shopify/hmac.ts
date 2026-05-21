import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 con comparación constant-time.
 *
 * Patrón crítico (Sección 3.2 + R7):
 *   1. Body raw como buffer ANTES de parsear JSON.
 *   2. Calcular HMAC-SHA256(secret, body) → base64.
 *   3. timingSafeEqual contra header `X-Shopify-Hmac-Sha256`.
 *   4. Falla → 401 sin loguear body (data sensible).
 *
 * El secret en el flujo nuevo del Dev Dashboard es el Client Secret
 * (Shopify firma webhooks con él). En vault_keys vive como
 * `shopify.client_secret`; en .env.local SHOPIFY_WEBHOOK_SECRET
 * es el mismo valor por claridad operativa.
 */
export function verifyShopifyHmac(
  rawBody: Buffer | string,
  hmacHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!hmacHeader || typeof hmacHeader !== "string") return false;
  if (!secret) return false;

  const expected = createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody)
    .digest();

  let received: Buffer;
  try {
    received = Buffer.from(hmacHeader, "base64");
  } catch {
    return false;
  }

  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
