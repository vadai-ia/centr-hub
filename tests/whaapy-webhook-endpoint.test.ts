import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Integración del endpoint público /api/webhooks/whaapy (M4).
 * Valida disciplina end-to-end espejo del de Shopify:
 *   - HMAC válido → 200 + encolado.
 *   - HMAC inválido → 401.
 *   - X-Webhook-Delivery-ID duplicado → 1 sola operación.
 *   - X-Webhook-ID reusado (whaapy lo persiste por contact_id)
 *     pero delivery_id distinto → 200 + encolado en cada delivery.
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
  /** Header `x-webhook-delivery-id` — único por entrega, key real del dedup. */
  deliveryId?: string;
  /**
   * Header `x-webhook-id` — Whaapy lo reusa por contact_id, NO se
   * usa para dedup. Solo presente para que los tests de regresión
   * puedan validar que el endpoint NO se confunde con este header.
   */
  webhookId?: string;
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
  if (opts.deliveryId) headers["x-webhook-delivery-id"] = opts.deliveryId;
  if (opts.webhookId) headers["x-webhook-id"] = opts.webhookId;
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
      deliveryId: "whd_test_1",
      signatureOverride: Buffer.from("fakefakefakefakefakefakefake").toString("base64"),
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("HMAC válido + topic conocido → 200 + encolado (payload real con businessId en root)", async () => {
    const req = buildRequest({
      body: realWhaapyPayload(),
      deliveryId: "whd_ok",
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const calls = sendMock.mock.calls as unknown as Array<
      [{ name: string; data: { topic: string; organizationId: string; whaapyBusinessId: string; deliveryId: string } }]
    >;
    expect(calls[0][0].name).toBe("whaapy/contact.created");
    expect(calls[0][0].data.topic).toBe("contact.created");
    expect(calls[0][0].data.organizationId).toBe(ORG_ID);
    expect(calls[0][0].data.whaapyBusinessId).toBe(BUSINESS_ID);
    expect(calls[0][0].data.deliveryId).toBe("whd_ok");
  });

  it("idempotencia: mismo X-Webhook-Delivery-ID 2 veces → solo 1 encolado", async () => {
    const body = {
      event: "contact.updated",
      timestamp: "2026-05-22T23:28:04.685Z",
      businessId: BUSINESS_ID,
      data: { contact_id: "c2", updated_fields: ["name"] },
    };
    const r1 = buildRequest({ body, deliveryId: "whd_dup_id" });
    const r2 = buildRequest({ body, deliveryId: "whd_dup_id" });
    const res1 = await POST(r1 as unknown as Parameters<typeof POST>[0]);
    const res2 = await POST(r2 as unknown as Parameters<typeof POST>[0]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("regresión M4: 3 deliveries con MISMO x-webhook-id pero DISTINTO x-webhook-delivery-id → las 3 pasan dedup", async () => {
    // Reproduce el bug original: Whaapy reusa `x-webhook-id` por
    // contact_id durante todo el ciclo de vida del contact. Antes
    // del fix, los updates 2..N caían a dedup_hit. Tras el fix, el
    // dedup se basa en `x-webhook-delivery-id` (único por entrega).
    const sharedWebhookId = "306dde2b-bb55-4652-8b76-c203eb2efd2b";
    const body1 = {
      event: "contact.updated",
      businessId: BUSINESS_ID,
      data: { contact_id: "c-update", updated_fields: ["name"], updated_at: "2026-05-23T05:00:00Z" },
    };
    const body2 = { ...body1, data: { ...body1.data, updated_at: "2026-05-23T05:22:00Z" } };
    const body3 = { ...body1, data: { ...body1.data, updated_at: "2026-05-23T05:28:00Z" } };
    const r1 = buildRequest({ body: body1, webhookId: sharedWebhookId, deliveryId: "whd_aaa" });
    const r2 = buildRequest({ body: body2, webhookId: sharedWebhookId, deliveryId: "whd_bbb" });
    const r3 = buildRequest({ body: body3, webhookId: sharedWebhookId, deliveryId: "whd_ccc" });
    const res1 = await POST(r1 as unknown as Parameters<typeof POST>[0]);
    const res2 = await POST(r2 as unknown as Parameters<typeof POST>[0]);
    const res3 = await POST(r3 as unknown as Parameters<typeof POST>[0]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res3.status).toBe(200);
    expect(res1.headers.get("x-centrhub-dedup")).toBe("miss");
    expect(res2.headers.get("x-centrhub-dedup")).toBe("miss");
    expect(res3.headers.get("x-centrhub-dedup")).toBe("miss");
    expect(sendMock).toHaveBeenCalledTimes(3);
  });

  it("retry del proveedor: 2 deliveries con MISMO x-webhook-delivery-id (mismo evento, reintento) → segundo es deduped", async () => {
    // Whaapy reintenta tras un fallo HTTP 4xx/5xx con el MISMO
    // delivery_id (es el mismo evento físico). El dedup correcto
    // descarta el segundo intento para que el worker no procese
    // dos veces.
    const body = {
      event: "contact.updated",
      businessId: BUSINESS_ID,
      data: { contact_id: "c-retry", updated_fields: ["name"], updated_at: "2026-05-23T05:00:00Z" },
    };
    const r1 = buildRequest({ body, deliveryId: "whd_retry_id" });
    const r2 = buildRequest({ body, deliveryId: "whd_retry_id" });
    const res1 = await POST(r1 as unknown as Parameters<typeof POST>[0]);
    const res2 = await POST(r2 as unknown as Parameters<typeof POST>[0]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.headers.get("x-centrhub-dedup")).toBe("miss");
    expect(res2.headers.get("x-centrhub-dedup")).toBe("hit");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("topic desconocido (message.received) → 200 + audit + no encolado", async () => {
    const req = buildRequest({
      body: { event: "message.received", businessId: BUSINESS_ID, data: {} },
      deliveryId: "whd_unknown",
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
      deliveryId: "whd_unknown_biz",
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("payload sin businessId en root → 200 sin encolar (no acumular DLQ Whaapy)", async () => {
    const req = buildRequest({
      // No businessId at root — debe rechazar
      body: { event: "contact.created", data: { contact_id: "x" } },
      deliveryId: "whd_no_biz",
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
      deliveryId: "whd_nested_bug",
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

  // ============================================================
  // Visibilidad del endpoint — audit edge antes del enqueue
  // ============================================================

  it("happy path → audit whaapy_webhook_received escrito en endpoint ANTES del enqueue", async () => {
    const req = buildRequest({
      body: realWhaapyPayload(),
      deliveryId: "whd_edge_audit",
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const audit = fakeSupabase.getTable("audit_log");
    const received = audit.filter((r) => r.event_type === "whaapy_webhook_received");
    expect(received.length).toBe(1);
    const row = received[0] as {
      organization_id: string;
      payload: { topic: string; whaapy_delivery_id: string; source: string };
    };
    expect(row.organization_id).toBe(ORG_ID);
    expect(row.payload.topic).toBe("contact.created");
    expect(row.payload.whaapy_delivery_id).toBe("whd_edge_audit");
    expect(row.payload.source).toBe("endpoint");
  });

  it("dedup hit → audit whaapy_webhook_deduped escrito + 200 + 1 sola corrida de enqueue", async () => {
    const body = realWhaapyPayload({
      data: {
        contact_id: "dup-contact",
        name: "Dup Test",
        phone_number: "+525500001111",
        tags: [],
        created_at: "2026-05-22T23:28:04.000Z",
      },
    });
    const r1 = buildRequest({ body, deliveryId: "whd_dup_edge" });
    const r2 = buildRequest({ body, deliveryId: "whd_dup_edge" });
    const res1 = await POST(r1 as unknown as Parameters<typeof POST>[0]);
    const res2 = await POST(r2 as unknown as Parameters<typeof POST>[0]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res2.headers.get("x-centrhub-dedup")).toBe("hit");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const audit = fakeSupabase.getTable("audit_log");
    const received = audit.filter((r) => r.event_type === "whaapy_webhook_received");
    const deduped = audit.filter((r) => r.event_type === "whaapy_webhook_deduped");
    // El primero escribe received; el segundo (dedup hit) escribe
    // received TAMBIÉN porque el audit edge ocurre ANTES del dedup,
    // y luego escribe deduped al detectar el hit.
    expect(received.length).toBe(2);
    expect(deduped.length).toBe(1);
    const dedupRow = deduped[0] as {
      organization_id: string;
      payload: { whaapy_delivery_id: string; topic: string };
    };
    expect(dedupRow.organization_id).toBe(ORG_ID);
    expect(dedupRow.payload.whaapy_delivery_id).toBe("whd_dup_edge");
    expect(dedupRow.payload.topic).toBe("contact.created");
  });

  it("inngest.send throwea → audit whaapy_webhook_enqueue_failed escrito + 503", async () => {
    sendMock.mockRejectedValueOnce(new Error("inngest_unreachable"));
    const req = buildRequest({
      body: realWhaapyPayload({
        data: {
          contact_id: "fail-contact",
          name: "Fail Test",
          phone_number: "+525500002222",
          tags: [],
          created_at: "2026-05-22T23:28:04.000Z",
        },
      }),
      deliveryId: "whd_enqueue_fail",
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(503);
    const audit = fakeSupabase.getTable("audit_log");
    const received = audit.filter((r) => r.event_type === "whaapy_webhook_received");
    const failed = audit.filter((r) => r.event_type === "whaapy_webhook_enqueue_failed");
    expect(received.length).toBe(1);
    expect(failed.length).toBe(1);
    const failRow = failed[0] as {
      organization_id: string;
      payload: { whaapy_delivery_id: string; topic: string; error: string };
    };
    expect(failRow.organization_id).toBe(ORG_ID);
    expect(failRow.payload.whaapy_delivery_id).toBe("whd_enqueue_fail");
    expect(failRow.payload.topic).toBe("contact.created");
    expect(failRow.payload.error).toBe("inngest_unreachable");
  });
});
