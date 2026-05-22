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

/**
 * Payload de referencia con la estructura REAL que Whaapy entrega
 * (validada en producción contra el webhook real recibido tras el
 * deploy de M4 — businessId vive en root, NO dentro de data, y el
 * identificador del contacto se llama `contact_id`).
 */
function realWhaapyPayload(overrides: Record<string, unknown> = {}) {
  return {
    event: "contact.created",
    timestamp: "2026-05-22T23:28:04.685Z",
    businessId: BUSINESS_ID,
    data: {
      contact_id: "1db0bff4-aaaa-4444-9999-faaf93b40000",
      name: "Test Contact",
      phone_number: "+525500000000",
      tags: [],
      created_at: "2026-05-22T23:28:04.000Z",
    },
    ...overrides,
  };
}

describe("POST /api/webhooks/whaapy", () => {
  it("HMAC inválido → 401 + no encolado", async () => {
    const req = buildRequest({
      body: realWhaapyPayload(),
      eventId: "ev-1",
      signatureOverride: Buffer.from("fakefakefakefakefakefakefake").toString("base64"),
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("HMAC válido + topic conocido → 200 + encolado (payload real con businessId en root)", async () => {
    const req = buildRequest({
      body: realWhaapyPayload(),
      eventId: "ev-ok",
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const calls = sendMock.mock.calls as unknown as Array<
      [{ name: string; data: { topic: string; organizationId: string; whaapyBusinessId: string } }]
    >;
    expect(calls[0][0].name).toBe("whaapy/contact.created");
    expect(calls[0][0].data.topic).toBe("contact.created");
    expect(calls[0][0].data.organizationId).toBe(ORG_ID);
    expect(calls[0][0].data.whaapyBusinessId).toBe(BUSINESS_ID);
  });

  it("idempotencia: mismo X-Webhook-ID 2 veces → solo 1 encolado", async () => {
    const body = {
      event: "contact.updated",
      timestamp: "2026-05-22T23:28:04.685Z",
      businessId: BUSINESS_ID,
      data: { contact_id: "c2", updated_fields: ["name"] },
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
      body: { event: "message.received", businessId: BUSINESS_ID, data: {} },
      eventId: "ev-unknown",
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
    const audit = fakeSupabase.getTable("audit_log");
    expect(audit.some((row) => row.event_type === "unhandled_whaapy_event")).toBe(true);
  });

  it("businessId desconocido (en root) → 200 sin encolar", async () => {
    fakeSupabase.setTable("organizations", []);
    const req = buildRequest({
      body: realWhaapyPayload({ businessId: "biz-otra" }),
      eventId: "ev-unknown-biz",
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("payload sin businessId en root → 200 sin encolar (no acumular DLQ Whaapy)", async () => {
    const req = buildRequest({
      // No businessId at root — debe rechazar
      body: { event: "contact.created", data: { contact_id: "x" } },
      eventId: "ev-no-biz",
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("regresión: businessId DENTRO de data NO debe resolver tenant (bug previo a este fix)", async () => {
    // Estructura incorrecta que asumía la implementación original:
    // businessId anidado dentro de data → debe ser ignorado.
    const req = buildRequest({
      body: {
        event: "contact.created",
        data: { contact_id: "x", businessId: BUSINESS_ID, name: "Test" },
      },
      eventId: "ev-nested-bug",
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("header x-webhook-signature ausente → 400", async () => {
    const bodyStr = JSON.stringify(realWhaapyPayload());
    const req = new Request("http://localhost/api/webhooks/whaapy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bodyStr,
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });
});
