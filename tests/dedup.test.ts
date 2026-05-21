import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Test del dedup atómico en Upstash (Sección 3.2 — patrón
 * operativo webhooks). Mockea `@upstash/redis` con un store
 * en memoria que respeta semántica SET NX EX.
 */

const store = new Map<string, { value: string; expiresAt: number }>();

vi.mock("@upstash/redis", () => {
  return {
    Redis: class FakeRedis {
      async set(key: string, value: string, opts?: { nx?: boolean; ex?: number }) {
        const now = Date.now();
        const existing = store.get(key);
        if (existing && existing.expiresAt > now) {
          if (opts?.nx) return null;
        }
        const expiresAt = opts?.ex ? now + opts.ex * 1000 : now + 24 * 60 * 60 * 1000;
        store.set(key, { value, expiresAt });
        return "OK";
      }
      async del(key: string) {
        store.delete(key);
        return 1;
      }
    },
  };
});

// Forzar env vars antes del import.
process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

import { reserveOnce, clearDedupMark } from "@/lib/redis/dedup";
import { __resetRedisClientForTests } from "@/lib/redis/client";

beforeEach(() => {
  store.clear();
  __resetRedisClientForTests();
});

afterEach(() => {
  store.clear();
});

describe("dedup atómico SET NX EX", () => {
  it("primer SET con eventId nuevo retorna true (procesar)", async () => {
    const ok = await reserveOnce({ namespace: "shopify", eventId: "ev-1" });
    expect(ok).toBe(true);
  });

  it("segundo SET con mismo eventId retorna false (descartar)", async () => {
    await reserveOnce({ namespace: "shopify", eventId: "ev-2" });
    const second = await reserveOnce({ namespace: "shopify", eventId: "ev-2" });
    expect(second).toBe(false);
  });

  it("eventIds distintos no colisionan", async () => {
    const a = await reserveOnce({ namespace: "shopify", eventId: "ev-A" });
    const b = await reserveOnce({ namespace: "shopify", eventId: "ev-B" });
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it("namespaces distintos no colisionan", async () => {
    const a = await reserveOnce({ namespace: "shopify", eventId: "ev-X" });
    const b = await reserveOnce({ namespace: "whaapy", eventId: "ev-X" });
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it("clearDedupMark permite reprocesar el mismo eventId", async () => {
    await reserveOnce({ namespace: "shopify", eventId: "ev-clear" });
    await clearDedupMark({ namespace: "shopify", eventId: "ev-clear" });
    const second = await reserveOnce({ namespace: "shopify", eventId: "ev-clear" });
    expect(second).toBe(true);
  });

  it("simulación de race: dos requests paralelas con mismo eventId — solo una gana", async () => {
    const [a, b] = await Promise.all([
      reserveOnce({ namespace: "shopify", eventId: "race-1" }),
      reserveOnce({ namespace: "shopify", eventId: "race-1" }),
    ]);
    // Solo uno gana (true), el otro pierde (false).
    expect([a, b].filter(Boolean).length).toBe(1);
  });
});
