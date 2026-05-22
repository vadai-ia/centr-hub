import { NextResponse, type NextRequest } from "next/server";
import { verifyWhaapyHmac } from "@/lib/whaapy/hmac";
import { reserveOnce } from "@/lib/redis/dedup";
import { getOrganizationByWhaapyBusinessId } from "@/lib/db/organizations";
import { getWhaapyWebhookSecret } from "@/lib/vault";
import {
  getInngestClient,
  WHAAPY_TOPIC_TO_INNGEST,
  type WhaapyWebhookEnvelope,
} from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { recordAuditEvent, createNotification } from "@/lib/db/operational";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  extractBusinessId,
  extractTopic,
} from "@/lib/whaapy/mappers";
import {
  WHAAPY_EVENT_ID_HEADER,
  WHAAPY_SIGNATURE_HEADER,
} from "@/lib/whaapy/config";
import type { Json, UUID } from "@/lib/types/database";

/**
 * Endpoint público de webhooks Whaapy (M4).
 *
 * Disciplina (espejo del flujo Shopify con diferencias documentadas
 * en CLAUDE.md / prompt M4):
 *   1. Body raw como Buffer ANTES de parsear.
 *   2. Parse JSON para resolver tenant por `businessId` (root del
 *      payload, NO `data.businessId` — ver entrada en ERRORES.md).
 *   3. HMAC-SHA256 verify con `X-Webhook-Signature` contra el
 *      webhook_secret de la org (Vault).
 *   4. Dedup atómico en Upstash (`SET NX EX 24h`) con `X-Webhook-ID`.
 *   5. Encolar a Inngest con envelope normalizado.
 *   6. 200 en <5s. Eventos no soportados → 200 + audit log
 *      (no acumular DLQ del lado Whaapy).
 *
 * HMAC falla → 401. Topic no soportado → 200 + audit (Whaapy
 * podría agregar eventos nuevos al contrato; no rompemos el endpoint).
 *
 * Whaapy desactiva el webhook tras 10 fallos consecutivos — siempre
 * que sea posible devolvemos 200 incluso para errores no-recuperables
 * para no agotar el contador del lado Whaapy.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNHANDLED_EVENT_NOTIFY_THRESHOLD = 5;
const UNHANDLED_EVENT_WINDOW_HOURS = 24;

export async function POST(req: NextRequest): Promise<NextResponse> {
  let bodyBuf: Buffer;
  try {
    const ab = await req.arrayBuffer();
    bodyBuf = Buffer.from(ab);
  } catch {
    return new NextResponse("invalid_body", { status: 400 });
  }

  const signatureHeader = req.headers.get(WHAAPY_SIGNATURE_HEADER);
  const eventIdHeader = req.headers.get(WHAAPY_EVENT_ID_HEADER);
  const receivedAt = new Date().toISOString();

  if (!signatureHeader) {
    return new NextResponse("missing_signature", { status: 400 });
  }

  // 1. Parse JSON ANTES de HMAC porque necesitamos businessId para
  //    resolver el tenant y el webhook_secret asociado. El HMAC se
  //    valida contra el buffer raw original — el parseo solo se usa
  //    para extraer businessId y topic, no para modificar el body.
  let payload: Json;
  try {
    payload = JSON.parse(bodyBuf.toString("utf8")) as Json;
  } catch {
    return new NextResponse("invalid_json", { status: 400 });
  }

  const businessId = extractBusinessId(payload);
  if (!businessId) {
    // Sin businessId no podemos resolver tenant — 200 para no
    // acumular DLQ del lado Whaapy, pero registramos a stdout.
    // eslint-disable-next-line no-console
    console.warn("whaapy_webhook_missing_business_id");
    return new NextResponse("ok", { status: 200 });
  }

  // 2. Resolver tenant.
  const org = await getOrganizationByWhaapyBusinessId(businessId);
  if (!org) {
    // eslint-disable-next-line no-console
    console.warn("whaapy_webhook_unknown_business", { businessId });
    return new NextResponse("ok", { status: 200 });
  }

  // 3. HMAC verify.
  let secret: string;
  try {
    secret = await getWhaapyWebhookSecret(org.id);
  } catch {
    // Sin secret no podemos validar. 401 — Whaapy debería pausar
    // tras fallos consecutivos, lo que es OK: el operador debe
    // correr `whaapy:configure-webhook` para poblar el secret.
    return new NextResponse("missing_secret", { status: 401 });
  }
  if (!verifyWhaapyHmac(bodyBuf, signatureHeader, secret)) {
    return new NextResponse("invalid_hmac", { status: 401 });
  }

  // 4. Resolver topic. Whaapy lo emite en el body (`event` o `topic`).
  const topic = extractTopic(payload);
  if (!topic) {
    await safeAuditUnhandled(org.id, "unknown", eventIdHeader);
    return new NextResponse("ok", { status: 200 });
  }

  // 5. Dedup atómico (después de HMAC para no gastar Redis en spam).
  const eventId = eventIdHeader ?? cryptoRandomFallback();
  let firstDelivery: boolean;
  try {
    firstDelivery = await reserveOnce({
      namespace: "whaapy",
      eventId,
      topic,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("whaapy_webhook_dedup_failed", {
      eventId,
      topic,
      err: (err as Error).message,
    });
    firstDelivery = true;
  }
  if (!firstDelivery) {
    return new NextResponse("ok", { status: 200, headers: { "x-centrhub-dedup": "hit" } });
  }

  // 6. Topic → evento Inngest. Topic no soportado = audit + 200.
  const inngestEvent = WHAAPY_TOPIC_TO_INNGEST[topic];
  if (!inngestEvent) {
    await handleUnhandledEvent(org.id, topic, eventId);
    return new NextResponse("ok", { status: 200 });
  }

  const envelope: WhaapyWebhookEnvelope = {
    organizationId: org.id as UUID,
    whaapyBusinessId: businessId,
    eventId,
    topic,
    receivedAt,
    payload,
  };

  // 7. Encolar a Inngest.
  try {
    await getInngestClient().send({
      name: inngestEvent,
      data: envelope,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("whaapy_webhook_enqueue_failed", {
      topic,
      eventId,
      err: (err as Error).message,
    });
    return new NextResponse("enqueue_failed", { status: 503 });
  }

  return new NextResponse("ok", { status: 200, headers: { "x-centrhub-dedup": "miss" } });
}

function cryptoRandomFallback(): string {
  return `local-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

async function safeAuditUnhandled(
  organizationId: UUID,
  topic: string,
  eventId: string | null,
): Promise<void> {
  try {
    await withTenantContext(
      organizationId,
      async () => {
        await recordAuditEvent({
          actorUserId: null,
          eventType: "unhandled_whaapy_event",
          entityType: null,
          entityId: null,
          payload: { topic, eventId },
        });
      },
      { source: "webhook" },
    );
  } catch {
    // no bloquear
  }
}

async function handleUnhandledEvent(
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
          eventType: "unhandled_whaapy_event",
          entityType: null,
          entityId: null,
          payload: { topic, eventId },
        });
        // Notificación admin si el mismo topic apareció más de N veces
        // en las últimas 24h (CLAUDE.md / prompt M4 — protección contra
        // ruido sin perder señal).
        const supabase = getSupabaseAdminClient();
        const cutoff = new Date(
          Date.now() - UNHANDLED_EVENT_WINDOW_HOURS * 60 * 60 * 1000,
        ).toISOString();
        const { data: prior } = await supabase
          .from("audit_log")
          .select("id, payload")
          .eq("organization_id", organizationId)
          .eq("event_type", "unhandled_whaapy_event")
          .gte("created_at", cutoff);
        const count =
          (prior ?? []).filter((row) => {
            const p = (row as { payload?: { topic?: string } }).payload;
            return p?.topic === topic;
          }).length;
        if (count >= UNHANDLED_EVENT_NOTIFY_THRESHOLD) {
          const { data: admins } = await supabase
            .from("memberships")
            .select("user_id")
            .eq("organization_id", organizationId)
            .eq("role", "admin")
            .eq("is_active", true);
          for (const adm of admins ?? []) {
            await createNotification({
              user_id: (adm as { user_id: UUID }).user_id,
              notification_type: "whaapy_unhandled_event_recurring",
              origin: "system",
              origin_reference: { topic, count },
              opportunity_id: null,
              contact_id: null,
              title: "Webhook Whaapy no soportado recurrente",
              message: `Whaapy envía topic "${topic}" repetido (${count} veces / ${UNHANDLED_EVENT_WINDOW_HOURS}h). Revisar.`,
              amount_at_stake: null,
              due_at: null,
              status: "pending",
              snoozed_until: null,
              schema_version: "1",
              completed_at: null,
            });
          }
        }
      },
      { source: "webhook" },
    );
  } catch {
    // no bloquear
  }
}
