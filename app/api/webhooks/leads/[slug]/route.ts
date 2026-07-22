import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { reserveOnce } from "@/lib/redis/dedup";
import { getRedisClient } from "@/lib/redis/client";
import { findInboundWebhookSourceBySlug } from "@/lib/db/inbound-webhook-sources";
import { verifyWebhookToken } from "@/lib/services/webhook-token";
import { parseLeadWebhookPayload } from "@/lib/services/lead-payload";
import {
  getInngestClient,
  LEAD_WEBHOOK_CREATE_EVENT,
  type LeadWebhookEnvelope,
} from "@/lib/inngest/client";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { UUID } from "@/lib/types/database";

/**
 * Endpoint PÚBLICO de creación de leads por webhook (0038, Bloque B).
 *
 *   POST /api/webhooks/leads/{slug}
 *
 * `slug` (globalmente único) identifica la fuente + su organización. Auth
 * por TOKEN de la fuente (constant-time contra el hash almacenado); el
 * token puede ir en header `x-centrhub-token`, `Authorization: Bearer` o
 * body `token`. Payload validado con Zod (name+phone obligatorios). Dedup
 * en Upstash (SET NX EX), rate-limit por fuente, e instrumentación
 * `exit_reason` en `whaapy_raw_webhooks` (endpoint="leads", token redactado)
 * — misma observabilidad tenant-independiente que el resto de endpoints.
 *
 * El endpoint NO crea el lead: encola a Inngest y responde rápido; el worker
 * `leadWebhookCreate` corre el camino canónico `createLead`.
 *
 * Este endpoint vive bajo `/api/webhooks/*` → excluido del middleware de
 * auth (server-to-server, sin cookies).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_HEADER = "x-centrhub-token";
const RATE_LIMIT_PER_MIN = 120;
const DEDUP_TTL_SECONDS = 24 * 60 * 60;

export async function POST(
  req: NextRequest,
  { params }: { params: { slug: string } },
): Promise<NextResponse> {
  const slug = params.slug;

  let bodyBuf: Buffer;
  try {
    bodyBuf = Buffer.from(await req.arrayBuffer());
  } catch {
    return new NextResponse("invalid_body", { status: 400 });
  }

  const headerToken = req.headers.get(TOKEN_HEADER);
  const rawId = await recordProductiveIngress(req.headers, bodyBuf);

  // Resolver la fuente (y su org) por slug. Cliente admin — pre-tenant.
  const source = await findInboundWebhookSourceBySlug(slug);
  if (!source) {
    await tagExitReason(rawId, "unknown_source");
    return new NextResponse("not_found", { status: 404 });
  }
  if (!source.is_active) {
    await tagExitReason(rawId, "source_revoked");
    return new NextResponse("revoked", { status: 403 });
  }

  // Auth por token de la fuente (header / bearer / body), constant-time.
  let bodyToken: string | null = null;
  try {
    const maybe = JSON.parse(bodyBuf.toString("utf8"));
    if (maybe && typeof maybe === "object" && typeof maybe.token === "string") {
      bodyToken = maybe.token;
    }
  } catch {
    // el parse "real" viene abajo; aquí solo intentamos extraer el token
  }
  const providedToken = headerToken ?? bearerToken(req) ?? bodyToken;
  if (!providedToken || !verifyWebhookToken(providedToken, source.token_hash)) {
    await tagExitReason(rawId, "invalid_token");
    return new NextResponse("invalid_token", { status: 401 });
  }

  // Rate-limit por fuente (ventana de 1 min). Redis caído → no bloquea.
  if (await isRateLimited(source.id)) {
    await tagExitReason(rawId, "rate_limited");
    return new NextResponse("rate_limited", { status: 429 });
  }

  // Parse + validación Zod del payload.
  let parsed;
  try {
    const json = JSON.parse(bodyBuf.toString("utf8"));
    parsed = parseLeadWebhookPayload(json);
  } catch (err) {
    if (err instanceof z.ZodError) {
      await tagExitReason(rawId, "invalid_payload");
      return NextResponse.json(
        { error: "invalid_payload", issues: err.issues.map((i) => ({ path: i.path, message: i.message })) },
        { status: 422 },
      );
    }
    await tagExitReason(rawId, "invalid_json");
    return new NextResponse("invalid_json", { status: 400 });
  }

  // Dedup: por external_id si vino, si no por hash del body.
  const dedupId = parsed.externalId ?? sha256Hex(bodyBuf).slice(0, 40);
  let firstDelivery = true;
  try {
    firstDelivery = await reserveOnce({
      namespace: "leads",
      topic: source.slug,
      eventId: dedupId,
      ttlSeconds: DEDUP_TTL_SECONDS,
    });
  } catch {
    firstDelivery = true;
  }
  if (!firstDelivery) {
    await tagExitReason(rawId, "dedup_hit");
    return new NextResponse("duplicate", { status: 200, headers: { "x-centrhub-dedup": "hit" } });
  }

  const receivedAt = new Date().toISOString();
  const envelope: LeadWebhookEnvelope = {
    organizationId: source.organization_id as UUID,
    inboundWebhookSourceId: source.id as UUID,
    deliveryId: dedupId,
    receivedAt,
    payload: {
      fullName: parsed.fullName,
      phone: parsed.phone,
      email: parsed.email,
      address: parsed.address,
    },
  };

  try {
    await getInngestClient().send({ name: LEAD_WEBHOOK_CREATE_EVENT, data: envelope });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("lead_webhook_enqueue_failed", {
      slug,
      source_id: source.id,
      err: (err as Error).message,
    });
    await tagExitReason(rawId, "enqueue_failed");
    return new NextResponse("enqueue_failed", { status: 503 });
  }

  await tagExitReason(rawId, "enqueue_succeeded");
  return new NextResponse("accepted", { status: 202, headers: { "x-centrhub-dedup": "miss" } });
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function bearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : null;
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function isRateLimited(sourceId: string): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const bucket = Math.floor(Date.now() / 60000);
    const key = `leadrl:${sourceId}:${bucket}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 120);
    return count > RATE_LIMIT_PER_MIN;
  } catch {
    // Redis no disponible → no bloquear la creación de leads.
    return false;
  }
}

/**
 * Persiste la request en `whaapy_raw_webhooks` (endpoint="leads") con el
 * token REDACTADO (header, bearer y body `token`). Falla silenciosa —
 * observabilidad, no bloqueante. Reusa la tabla operativa tenant-independiente
 * (ERRORES.md "Cada endpoint inbound debe exponer un exit_reason auditable").
 */
async function recordProductiveIngress(
  headers: Headers,
  bodyBuf: Buffer,
): Promise<string | null> {
  try {
    const headerMap: Record<string, string> = {};
    const redacted = new Set([TOKEN_HEADER, "authorization"]);
    headers.forEach((v, k) => {
      headerMap[k] = redacted.has(k.toLowerCase()) ? "[redacted]" : v;
    });
    const rawBody = bodyBuf.toString("utf8");
    let body: unknown = null;
    try {
      const p = JSON.parse(rawBody);
      body =
        p && typeof p === "object" && "token" in p
          ? { ...(p as Record<string, unknown>), token: "[redacted]" }
          : p;
    } catch {
      body = null;
    }
    const safeRaw = rawBody.replace(/("token"\s*:\s*")[^"]*(")/, "$1[redacted]$2");
    const { data, error } = await getSupabaseAdminClient()
      .from("whaapy_raw_webhooks")
      .insert({ headers: headerMap, body, raw_body: safeRaw, endpoint: "leads" })
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
