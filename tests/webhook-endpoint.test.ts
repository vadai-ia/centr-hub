import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Integración del endpoint público de webhooks Shopify (M3).
 * Valida disciplina end-to-end:
 *   - HMAC válido → 200 + encolado a Inngest.
 *   - HMAC inválido → 401 sin encolado.
 *   - Mismo eventId 2 veces → 1 sola operación de encolado (dedup).
 *   - Topic desconocido → 200 + audit log.
 *   - Shop no resuelto → 200 sin encolado.
 */

const fakeSupabase = new FakeSupabase();
const sendMock = vi.fn(async () => ({ ids: ["evt-1"] }));
const dedupStore = new Map<string, number>();

process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.SHOPIFY_API_KEY = "fake-client-id";
process.env.SHOPIFY_API_SECRET = "shpss_test_secret";
process.env.SHOPIFY_WEBHOOK_SECRET = "shpss_test_secret";

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fakeSupabase,
}));

vi.mock("@upstash/redis", () => ({
  Redis: class FakeRedis {
    async set(key: string, _value: string, opts?: { nx?: boolean; ex?: number }) {
      const now = Date.now();
      const existing = dedupStore.get(key);
      if (existing && existing > now && opts?.nx) return null;
      dedupStore.set(key, now + (opts?.ex ?? 86400) * 1000);
      return "OK";
    }
    async del(key: string) {
      dedupStore.delete(key);
      return 1;
    }
  },
}));

vi.mock("inngest", () => {
  return {
    Inngest: class FakeInngest {
      constructor() {}
      send = sendMock;
      createFunction() {
        return {};
      }
    },
  };
});

import { POST } from "@/app/api/webhooks/shopify/route";
import { __resetRedisClientForTests } from "@/lib/redis/client";

const SHOP_DOMAIN = "centr-test.myshopify.com";
const SECRET = "shpss_test_secret";
const ORG_ID = "org-centr-test";

function buildRequest(opts: {
  topic: string;
  shopDomain: string;
  eventId: string;
  body: unknown;
  hmacOverride?: string;
}): Request {
  const bodyStr = JSON.stringify(opts.body);
  const hmac =
    opts.hmacOverride ??
    createHmac("sha256", SECRET).update(bodyStr, "utf8").digest("base64");
  return new Request("http://localhost/api/webhooks/shopify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": opts.topic,
      "x-shopify-shop-domain": opts.shopDomain,
      "x-shopify-webhook-id": opts.eventId,
      "x-shopify-hmac-sha256": hmac,
    },
    body: bodyStr,
  });
}

beforeEach(() => {
  fakeSupabase.reset();
  dedupStore.clear();
  sendMock.mockClear();
  __resetRedisClientForTests();
  fakeSupabase.setTable("organizations", [
    {
      id: ORG_ID,
      shopify_store_domain: SHOP_DOMAIN,
      vault_keys: {},
    },
  ]);
});

describe("POST /api/webhooks/shopify", () => {
  it("HMAC inválido → 401 + no encolado", async () => {
    const req = buildRequest({
      topic: "customers/create",
      shopDomain: SHOP_DOMAIN,
      eventId: "evt-1",
      body: { id: 1 },
      hmacOverride: Buffer.from("fakefakefakefakefakefakefake").toString("base64"),
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("HMAC válido + topic conocido → 200 + encolado", async () => {
    const req = buildRequest({
      topic: "customers/create",
      shopDomain: SHOP_DOMAIN,
      eventId: "evt-ok",
      body: { id: 42, email: "a@b.com" },
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const calls = sendMock.mock.calls as unknown as Array<
      [{ name: string; data: { topic: string; organizationId: string } }]
    >;
    expect(calls[0][0].name).toBe("shopify/customers.create");
    expect(calls[0][0].data.topic).toBe("customers/create");
    expect(calls[0][0].data.organizationId).toBe(ORG_ID);
  });

  it("idempotencia: mismo eventId 2 veces → solo 1 encolado", async () => {
    const body = { id: 100, email: "i@x.com" };
    const req1 = buildRequest({
      topic: "customers/update",
      shopDomain: SHOP_DOMAIN,
      eventId: "evt-dup",
      body,
    });
    const req2 = buildRequest({
      topic: "customers/update",
      shopDomain: SHOP_DOMAIN,
      eventId: "evt-dup",
      body,
    });
    const res1 = await POST(req1 as unknown as Parameters<typeof POST>[0]);
    const res2 = await POST(req2 as unknown as Parameters<typeof POST>[0]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("topic desconocido → 200 sin encolado", async () => {
    const req = buildRequest({
      topic: "checkouts/create",
      shopDomain: SHOP_DOMAIN,
      eventId: "evt-unknown",
      body: { id: 7 },
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("shop no registrado → 200 sin encolado (defensa: no acumular DLQ del lado Shopify)", async () => {
    fakeSupabase.setTable("organizations", []); // sin orgs
    const req = buildRequest({
      topic: "customers/create",
      shopDomain: "otra-tienda.myshopify.com",
      eventId: "evt-unknown-shop",
      body: { id: 1 },
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("headers obligatorios faltantes → 400", async () => {
    const bodyStr = JSON.stringify({ id: 1 });
    const req = new Request("http://localhost/api/webhooks/shopify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bodyStr,
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });
});
