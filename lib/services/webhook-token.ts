import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * Tokens de fuentes de webhook de leads (Bloque B). El token crudo se
 * muestra UNA sola vez al crear/rotar la fuente; en BD solo vive su
 * sha256 (`token_hash`). No se puede recuperar el crudo — patrón
 * "copiar ahora". Comparación constant-time en el endpoint.
 *
 * Módulo puro (crypto de Node): testeable sin BD. No lleva "server-only"
 * porque no toca secretos de la plataforma ni el cliente admin — solo
 * hashea/compara. NO importar desde un client component (usa node:crypto).
 */

const TOKEN_BYTES = 24; // 48 hex → ~192 bits de entropía
const SLUG_BYTES = 12; // 24 hex → segmento de URL no adivinable
const TOKEN_PREFIX = "lead_";

/** Token crudo de la fuente (se muestra 1 vez). Formato: `lead_<48 hex>`. */
export function generateWebhookToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("hex")}`;
}

/** Slug público del endpoint (`/api/webhooks/leads/{slug}`). Aleatorio. */
export function generateWebhookSlug(): string {
  return randomBytes(SLUG_BYTES).toString("hex");
}

/** sha256(hex) del token crudo — lo que se persiste. */
export function hashWebhookToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Últimos 4 chars del token crudo, para mostrar en la UI ("••••ab12"). */
export function tokenLast4(raw: string): string {
  return raw.slice(-4);
}

/**
 * Verifica un token crudo entrante contra el hash almacenado, en tiempo
 * constante (comparando los digests, no los crudos). Rechaza si el hash
 * provisto o el almacenado no son hex de igual longitud.
 */
export function verifyWebhookToken(providedRaw: string, storedHash: string): boolean {
  if (!providedRaw || !storedHash) return false;
  const providedHash = hashWebhookToken(providedRaw);
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(providedHash, "hex");
    b = Buffer.from(storedHash, "hex");
  } catch {
    return false;
  }
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
