import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { reserveOnce } from "@/lib/redis/dedup";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getWhaapyPostventaInboundToken } from "@/lib/vault";
import {
  getInngestClient,
  WHAAPY_POSTVENTA_INBOUND_EVENT,
  type WhaapyPostventaInboundEnvelope,
} from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { recordAuditEvent } from "@/lib/db/operational";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Json, UUID } from "@/lib/types/database";

/**
 * Endpoint del webhook 3 — INBOUND del Whaapy de POST-VENTA (Option A).
 *
 * NO es un webhook firmado por Whaapy: `contact.stage_changed` no existe.
 * Lo llama una **Automation `http_request`** (trigger `pipeline_stage_entered`
 * sobre "Caso Resuelto") con un body que definimos nosotros:
 *
 *   { "org": "<slug>", "phone": "{{contact.phoneNumber}}",
 *     "opportunity_id": "<opcional>", "token": "<opcional si va en header>" }
 *
 * Auth: TOKEN COMPARTIDO (constant-time), no HMAC. El token puede venir en
 * el header `x-centrhub-token` o en el body `token`. Se verifica contra el
 * Vault (`whaapy_postventa.inbound_token`).
 *
 * Tenant: por `org` (slug) del body — la automation lo lleva estático.
 *
 * Como el trigger YA es "Caso Resuelto", el worker no filtra etapa; la
 * idempotencia y el anti-bucle capa 1 (source inbound → no re-dispara
 * webhook 4) los da `resolvePostventaCase`. Devolvemos 200 salvo token
 * inválido/faltante (401).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_HEADER = "x-centrhub-token";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let bodyBuf: Buffer;
  try {
    bodyBuf = Buffer.from(await req.arrayBuffer());
  } catch {
    return new NextResponse("invalid_body", { status: 400 });
  }

  const headerToken = req.headers.get(TOKEN_HEADER);
  const rawId = await recordProductiveIngress(req.headers, bodyBuf);
  const receivedAt = new Date().toISOString();

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bodyBuf.toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("not_object");
    body = parsed as Record<string, unknown>;
  } catch {
    await tagExitReason(rawId, "invalid_json");
    return new NextResponse("invalid_json", { status: 400 });
  }

  const orgSlug = str(body.org) ?? str(body.org_slug);
  if (!orgSlug) {
    await tagExitReason(rawId, "missing_org");
    return new NextResponse("ok", { status: 200 });
  }

  const org = await getOrganizationBySlug(orgSlug);
  if (!org) {
    await tagExitReason(rawId, "organization_not_found");
    return new NextResponse("ok", { status: 200 });
  }

  // Auth por token compartido (header o body), constant-time.
  let expectedToken: string;
  try {
    expectedToken = await getWhaapyPostventaInboundToken(org.id);
  } catch {
    await tagExitReason(rawId, "missing_token_config");
    return new NextResponse("missing_token_config", { status: 401 });
  }
  const providedToken = headerToken ?? bearerToken(req) ?? str(body.token);
  if (!tokensMatch(providedToken, expectedToken)) {
    await tagExitReason(rawId, "invalid_token");
    return new NextResponse("invalid_token", { status: 401 });
  }

  const phone = str(body.phone);
  const opportunityId = str(body.opportunity_id);
  const deliveryId = str(body.delivery_id) ?? cryptoRandomFallback();

  await safeAuditAtEdge(org.id as UUID, {
    eventType: "postventa_whaapy_inbound_received",
    payload: {
      has_opportunity_id: !!opportunityId,
      has_phone: !!phone,
      delivery_id: deliveryId,
      received_at: receivedAt,
      source: "automation_http_request",
    } as Json,
  });

  // Dedup best-effort por caso (opp o teléfono). TTL corto: re-resolver el
  // mismo caso es no-op igualmente (resolvePostventaCase idempotente); esto
  // solo colapsa reintentos rápidos del http_request.
  const dedupKey = opportunityId ?? phone ?? deliveryId;
  let firstDelivery = true;
  try {
    firstDelivery = await reserveOnce({
      namespace: "whaapy_postventa",
      eventId: dedupKey,
      topic: "resolved",
      ttlSeconds: 300,
    });
  } catch {
    firstDelivery = true;
  }
  if (!firstDelivery) {
    await tagExitReason(rawId, "dedup_hit");
    return new NextResponse("ok", { status: 200, headers: { "x-centrhub-dedup": "hit" } });
  }

  const envelope: WhaapyPostventaInboundEnvelope = {
    organizationId: org.id as UUID,
    deliveryId,
    receivedAt,
    opportunityId,
    phone,
  };

  try {
    await getInngestClient().send({
      name: WHAAPY_POSTVENTA_INBOUND_EVENT,
      data: envelope,
    });
  } catch (err) {
    const errMsg = (err as Error).message;
    // eslint-disable-next-line no-console
    console.error("whaapy_postventa_inbound_enqueue_failed", { deliveryId, err: errMsg });
    await safeAuditAtEdge(org.id as UUID, {
      eventType: "postventa_whaapy_inbound_enqueue_failed",
      payload: { delivery_id: deliveryId, error: errMsg } as Json,
    });
    await tagExitReason(rawId, "enqueue_failed");
    return new NextResponse("enqueue_failed", { status: 503 });
  }

  await tagExitReason(rawId, "enqueue_succeeded");
  return new NextResponse("ok", { status: 200, headers: { "x-centrhub-dedup": "miss" } });
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Token desde `Authorization: Bearer <token>` (botón "Auth Bearer" de Whaapy). */
function bearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : null;
}

function tokensMatch(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cryptoRandomFallback(): string {
  return `auto-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Persiste la request en `whaapy_raw_webhooks` (endpoint="postventa").
 * REDACTA el token (header `x-centrhub-token` y body `token`) para no
 * dejar el secreto at-rest en la tabla de debug. Falla silenciosa.
 */
async function recordProductiveIngress(
  headers: Headers,
  bodyBuf: Buffer,
): Promise<string | null> {
  try {
    const headerMap: Record<string, string> = {};
    const redactedHeaders = new Set([TOKEN_HEADER, "authorization"]);
    headers.forEach((v, k) => {
      headerMap[k] = redactedHeaders.has(k.toLowerCase()) ? "[redacted]" : v;
    });
    const rawBody = bodyBuf.toString("utf8");
    let body: unknown = null;
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed && typeof parsed === "object" && "token" in parsed) {
        body = { ...(parsed as Record<string, unknown>), token: "[redacted]" };
      } else {
        body = parsed;
      }
    } catch {
      body = null;
    }
    // raw_body puede contener el token si vino en el body; lo redactamos
    // también para no persistir el secreto en claro.
    const safeRaw = rawBody.replace(
      /("token"\s*:\s*")[^"]*(")/,
      "$1[redacted]$2",
    );
    const { data, error } = await getSupabaseAdminClient()
      .from("whaapy_raw_webhooks")
      .insert({ headers: headerMap, body, raw_body: safeRaw, endpoint: "postventa" })
      .select("id")
      .single();
    if (error) return null;
    return (data as { id: string }).id;
  } catch {
    return null;
  }
}

async function tagExitReason(rawId: string | null, reason: string): Promise<void> {
  if (!rawId) return;
  try {
    await getSupabaseAdminClient()
      .from("whaapy_raw_webhooks")
      .update({ exit_reason: reason })
      .eq("id", rawId);
  } catch {
    // no bloquear
  }
}

async function safeAuditAtEdge(
  organizationId: UUID,
  input: { eventType: string; payload: Json },
): Promise<void> {
  try {
    await withTenantContext(
      organizationId,
      async () => {
        await recordAuditEvent({
          actorUserId: null,
          eventType: input.eventType,
          entityType: null,
          entityId: null,
          payload: input.payload,
        });
      },
      { source: "webhook" },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("whaapy_postventa_inbound_audit_failed", {
      event_type: input.eventType,
      err: (err as Error).message,
    });
  }
}
