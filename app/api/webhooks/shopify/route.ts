import { NextResponse, type NextRequest } from "next/server";
import { verifyShopifyHmac } from "@/lib/shopify/hmac";
import { reserveOnce } from "@/lib/redis/dedup";
import { getOrganizationByShopifyDomain } from "@/lib/db/organizations";
import { getShopifyWebhookSecret } from "@/lib/vault";
import {
  getInngestClient,
  SHOPIFY_TOPIC_TO_INNGEST,
  type ShopifyWebhookEnvelope,
} from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { recordAuditEvent } from "@/lib/db/operational";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { createNotification } from "@/lib/db/operational";
import type { UUID } from "@/lib/types/database";

/**
 * Endpoint público de webhooks Shopify (M3).
 *
 * Disciplina:
 *   1. Body raw como Buffer ANTES de parsear.
 *   2. HMAC-SHA256 verify con Client Secret de la org (Vault o env).
 *   3. Dedup atómico en Upstash (`SET NX EX 24h`) con `X-Shopify-Webhook-Id`.
 *   4. Resolución de tenant por `X-Shopify-Shop-Domain`.
 *   5. Encolar a Inngest con envelope normalizado.
 *   6. Respuesta 200 en <5s. Errores no-recuperables → 200 (no
 *      pedir a Shopify reintentar) pero audit log.
 *
 * HMAC falla → 401. Topic no soportado → 200 + audit (Shopify
 * suscribió algo que no manejamos — no es nuestro problema).
 */

export const runtime = "nodejs";
// Asegura que Next.js no cachee y siempre evalúe la lógica fresca.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let bodyBuf: Buffer;
  try {
    const ab = await req.arrayBuffer();
    bodyBuf = Buffer.from(ab);
  } catch {
    return new NextResponse("invalid_body", { status: 400 });
  }

  const topic = req.headers.get("x-shopify-topic");
  const shopDomain = req.headers.get("x-shopify-shop-domain");
  const hmacHeader = req.headers.get("x-shopify-hmac-sha256");
  const eventId = req.headers.get("x-shopify-webhook-id") ?? cryptoRandomFallback();
  const triggeredAt = req.headers.get("x-shopify-triggered-at");

  if (!topic || !shopDomain || !hmacHeader) {
    return new NextResponse("missing_headers", { status: 400 });
  }

  // 1. Resolución de tenant ANTES de HMAC (necesitamos el secret).
  const org = await getOrganizationByShopifyDomain(shopDomain);
  if (!org) {
    // No conocemos esta tienda — devuelve 200 para no acumular DLQ
    // del lado de Shopify, pero registra para diagnóstico.
    // eslint-disable-next-line no-console
    console.warn("shopify_webhook_unknown_shop", { shopDomain, topic });
    return new NextResponse("ok", { status: 200 });
  }

  // 2. HMAC verify.
  let secret: string;
  try {
    secret = await getShopifyWebhookSecret(org.id);
  } catch {
    // Sin secret no podemos validar. 401 para que Shopify no continúe.
    return new NextResponse("missing_secret", { status: 401 });
  }
  if (!verifyShopifyHmac(bodyBuf, hmacHeader, secret)) {
    return new NextResponse("invalid_hmac", { status: 401 });
  }

  // 3. Dedup atómico (después de HMAC para no gastar Redis en spam no auth).
  let firstDelivery: boolean;
  try {
    firstDelivery = await reserveOnce({
      namespace: "shopify",
      eventId,
      topic,
    });
  } catch (err) {
    // Si Redis falla, NO bloqueamos al webhook — log y procesa.
    // Tradeoff: prefiere procesamiento duplicado a perder un evento.
    // eslint-disable-next-line no-console
    console.error("shopify_webhook_dedup_failed", { eventId, topic, err: (err as Error).message });
    firstDelivery = true;
  }
  if (!firstDelivery) {
    return new NextResponse("ok", { status: 200, headers: { "x-centrhub-dedup": "hit" } });
  }

  // 4. Mapeo topic → evento Inngest. Topic no soportado = log + 200.
  const inngestEvent = SHOPIFY_TOPIC_TO_INNGEST[topic];
  if (!inngestEvent) {
    try {
      await withTenantContext(
        org.id,
        async () =>
          recordAuditEvent({
            actorUserId: null,
            eventType: "shopify_webhook_unsupported_topic",
            entityType: null,
            entityId: null,
            payload: { topic, eventId },
          }),
        { source: "webhook" },
      );
    } catch {
      // no bloquear
    }
    return new NextResponse("ok", { status: 200 });
  }

  // 5. Parse JSON (idempotente si el body ya fue parseado por dedup).
  let payload: unknown;
  try {
    payload = JSON.parse(bodyBuf.toString("utf8"));
  } catch {
    await notifyAdminOfMalformedPayload(org.id, topic, eventId);
    return new NextResponse("invalid_json", { status: 400 });
  }

  const envelope: ShopifyWebhookEnvelope = {
    organizationId: org.id as UUID,
    shopDomain,
    eventId,
    topic,
    triggeredAt,
    payload: payload as ShopifyWebhookEnvelope["payload"],
  };

  // 6. Encolar a Inngest.
  try {
    await getInngestClient().send({
      name: inngestEvent,
      data: envelope,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("shopify_webhook_enqueue_failed", {
      topic,
      eventId,
      err: (err as Error).message,
    });
    // Devolver 5xx para que Shopify reintente.
    return new NextResponse("enqueue_failed", { status: 503 });
  }

  return new NextResponse("ok", { status: 200, headers: { "x-centrhub-dedup": "miss" } });
}

function cryptoRandomFallback(): string {
  // Fallback solo para testing local; en prod Shopify SIEMPRE envía
  // `X-Shopify-Webhook-Id`.
  return `local-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

async function notifyAdminOfMalformedPayload(
  organizationId: UUID,
  topic: string,
  eventId: string,
): Promise<void> {
  try {
    await withTenantContext(
      organizationId,
      async () => {
        await recordAuditEvent({
          actorUserId: null,
          eventType: "shopify_webhook_malformed_json",
          entityType: null,
          entityId: null,
          payload: { topic, eventId },
        });
        const supabase = getSupabaseAdminClient();
        const { data: admins } = await supabase
          .from("memberships")
          .select("user_id")
          .eq("organization_id", organizationId)
          .eq("role", "admin")
          .eq("is_active", true);
        for (const adm of admins ?? []) {
          await createNotification({
            user_id: (adm as { user_id: UUID }).user_id,
            notification_type: "shopify_webhook_malformed",
            origin: "system",
            origin_reference: { topic, eventId },
            opportunity_id: null,
            contact_id: null,
            title: "Webhook Shopify malformado",
            message: `${topic}: payload no es JSON válido. Revisar logs.`,
            amount_at_stake: null,
            due_at: null,
            status: "pending",
            snoozed_until: null,
            schema_version: "1",
            completed_at: null,
          });
        }
      },
      { source: "webhook" },
    );
  } catch {
    // no bloquear
  }
}
