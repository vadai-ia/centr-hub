import "server-only";
import { getRedisClient } from "@/lib/redis/client";

/**
 * Dedup atómico para webhooks (Sección 3.2 — patrón operativo
 * webhooks). Operación: SET key marker NX EX ttl. NX garantiza que
 * solo el primer caller gana en caso de race; EX expira la key.
 *
 * TTL default 24h — cubre re-entregas de Shopify (que reintenta
 * típicamente 19 veces durante 48h pero el primer set cubre el
 * grueso) sin acumular keys eternamente.
 */

export interface DedupOptions {
  /** Namespace requerido para evitar colisión entre proveedores. */
  namespace: "shopify" | "whaapy" | "whaapy_postventa" | "leads";
  /** Identificador único del evento entregado por el proveedor. */
  eventId: string;
  /** Sufijo opcional para discriminar topics dentro del namespace. */
  topic?: string;
  /** Time-to-live en segundos (default 24h). */
  ttlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

function buildKey(opts: DedupOptions): string {
  const topicPart = opts.topic ? `:${opts.topic}` : "";
  return `dedup:${opts.namespace}${topicPart}:${opts.eventId}`;
}

export async function reserveOnce(opts: DedupOptions): Promise<boolean> {
  const redis = getRedisClient();
  const key = buildKey(opts);
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  // Upstash devuelve "OK" si el SET con NX ganó la operación, null si la key ya existía.
  const result = await redis.set(key, "1", { nx: true, ex: ttl });
  return result === "OK";
}

/** Útil para tests / debugging — borra la marca de dedup. */
export async function clearDedupMark(opts: DedupOptions): Promise<void> {
  const redis = getRedisClient();
  await redis.del(buildKey(opts));
}
