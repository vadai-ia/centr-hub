import "server-only";
import { Redis } from "@upstash/redis";
import { getServerEnv } from "@/lib/env";

/**
 * Cliente Upstash Redis (REST). Singleton — Upstash es HTTP-based
 * y la SDK ya maneja pooling internamente.
 */

let cached: Redis | null = null;

export function getRedisClient(): Redis {
  if (cached) return cached;
  const env = getServerEnv();
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error(
      "redis: UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN requeridos (M3 dedup webhooks)",
    );
  }
  cached = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
  return cached;
}

/**
 * Reset interno usado por tests.
 */
export function __resetRedisClientForTests(): void {
  cached = null;
}
