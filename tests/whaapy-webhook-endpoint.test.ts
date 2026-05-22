import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Integración del endpoint público /api/webhooks/whaapy (M4).
 * Valida disciplina end-to-end espejo del de Shopify:
 *   - HMAC válido → 200 + encolado.
 *   - HMAC inválido → 401.
 *   - X-Webhook-ID duplicado → 1 sola operación.
 *   - businessId desconocido → 200 sin encolar.
 *   - Topic desconocido → 200 + audit log.
 *   - sin businessId → 200 (no acumular DLQ del lado Whaapy).
 */

const fakeSupabase = new FakeSupabase();
const sendMock = vi.fn(async () => ({ ids: ["evt-1"] }));
const dedupStore = new Map<string, number>();

process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

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

import { POST } from "@/app/api/webhooks/whaapy/route";
import { __resetRedisClientForTests } from "@/lib/redis/client";

const BUSINESS_ID = "biz-centr";
const SECRET = "whaapy_test_secret";
const ORG_ID = "org-centr-test";

function buildRequest(opts: {
  body: unknown;
  eventId?: string;
  signatureOverride?: string;
}): Request {
  const bodyStr = JSON.stringify(opts.body);
  const sig =
    opts.signatureOverride ??
    createHmac("sha256", SECRET).update(bodyStr, "utf8").digest("base64");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-webhook-signature": sig,
  };
  if (opts.eventId) headers["x-webhook-id"] = opts.eventId;
  return new Request("http://localhost/api/webhooks/whaapy", {
    method: "POST",
    headers,
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
      whaapy_business_id: BUSINESS_ID,
      vault_keys: { whaapy: { webhook_secret: SECRET } },
    },
  ]);
});

describe("POST /api/webhooks/whaapy", () => {
  it("HMAC inválido → 401 + no encolado", async () => {
    const req = buildRequest({
      body: { event: "contact.created", data: { id: "c1", businessId: BUSINESS_ID } },
      eventId: "ev-1",
      signatureOverride: Buffer.from("fakefakefakefakefakefakefake").toString("base64"),
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("HMAC válido + topic conocido → 200 + encolado", async () => {
    const req = buildRequest({
      body: {
        event: "contact.created",
        data: {
          id: "c1",
          businessId: BUSINESS_ID,
          phone_number: "+525500000000",
          name: "Test",
        },
      },
      eventId: "ev-ok",
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const calls = sendMock.mock.calls as unknown as Array<
      [{ name: string; data: { topic: string; organizationId: string } }]
    >;
    expect(calls[0][0].name).toBe("whaapy/contact.created");
    expect(calls[0][0].data.topic).toBe("contact.created");
    expect(calls[0][0].data.organizationId).toBe(ORG_ID);
  });

  it("idempotencia: mismo X-Webhook-ID 2 veces → solo 1 encolado", async () => {
    const body = {
      event: "contact.updated",
      data: { id: "c2", businessId: BUSINESS_ID, updated_fields: ["name"] },
    };
    const r1 = buildRequest({ body, eventId: "dup-id" });
    const r2 = buildRequest({ body, eventId: "dup-id" });
    const res1 = await POST(r1 as unknown as Parameters<typeof POST>[0]);
    const res2 = await POST(r2 as unknown as Parameters<typeof POST>[0]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("topic desconocido (message.received) → 200 + audit + no encolado", async () => {
    const req = buildRequest({
      body: { event: "message.received", data: { businessId: BUSINESS_ID } },
      eventId: "ev-unknown",
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
    const audit = fakeSupabase.getTable("audit_log");
    expect(audit.some((row) => row.event_type === "unhandled_whaapy_event")).toBe(true);
  });

  it("businessId desconocido → 200 sin encolar", async () => {
    fakeSupabase.setTable("organizations", []);
    const req = buildRequest({
      body: { event: "contact.created", data: { id: "x", businessId: "biz-otra" } },
      eventId: "ev-unknown-biz",
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("payload sin businessId → 200 sin encolar", async () => {
    const req = buildRequest({
      body: { event: "contact.created", data: { id: "x" } },
      eventId: "ev-no-biz",
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("header x-webhook-signature ausente → 400", async () => {
    const bodyStr = JSON.stringify({ event: "contact.created", data: { businessId: BUSINESS_ID } });
    const req = new Request("http://localhost/api/webhooks/whaapy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bodyStr,
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });
});
