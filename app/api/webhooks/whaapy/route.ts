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
 *   4. Resolver topic.
 *   5. Audit `whaapy_webhook_received` a NIVEL ENDPOINT (visibilidad
 *      independiente del dispatch de Inngest — ver ERRORES.md
 *      "Endpoint Whaapy sin visibilidad por audit-only-in-worker").
 *   6. Dedup atómico en Upstash (`SET NX EX 24h`). Hit → audit
 *      `whaapy_webhook_deduped` + 200.
 *   7. Topic no soportado → audit `unhandled_whaapy_event` + 200.
 *   8. Encolar a Inngest con envelope normalizado. Falla → audit
 *      `whaapy_webhook_enqueue_failed` + 503.
 *   9. 200 en <5s en el happy path.
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
    // acumular DLQ del lado Whaapy. Registramos con payload
    // estructurado a Vercel runtime logs. NO podemos escribir
    // audit_log sin org_id (NOT NULL constraint en migración 0007);
    // ver PENDIENTES.md M4-DT-XX "audit_log.organization_id nullable".
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        event: "whaapy_webhook_discarded",
        discard_reason: "missing_business_id",
        signature_present: !!signatureHeader,
        event_id_header: eventIdHeader,
        received_at: receivedAt,
      }),
    );
    return new NextResponse("ok", { status: 200 });
  }

  // 2. Resolver tenant.
  const org = await getOrganizationByWhaapyBusinessId(businessId);
  if (!org) {
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        event: "whaapy_webhook_discarded",
        discard_reason: "organization_not_found",
        business_id: businessId,
        event_id_header: eventIdHeader,
        received_at: receivedAt,
      }),
    );
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

  const eventId = eventIdHeader ?? cryptoRandomFallback();

  // 5. Audit `whaapy_webhook_received` a NIVEL ENDPOINT (visibilidad
  //    independiente del estado del worker downstream — Inngest dispatch,
  //    signing key, etc.). Antes de dedup y enqueue. El worker también
  //    escribe su propio `whaapy_webhook_received` cuando arranca; los
  //    dos no son redundantes — el del endpoint prueba "el HTTP llegó y
  //    pasó HMAC", el del worker prueba "Inngest dispatchó y el handler
  //    arrancó". Si vemos el del endpoint pero no el del worker, sabemos
  //    que el problema es de dispatch. Ver ERRORES.md "Endpoint Whaapy
  //    sin visibilidad por audit-only-in-worker pattern".
  await safeAuditAtEdge(org.id as UUID, {
    eventType: "whaapy_webhook_received",
    payload: {
      topic,
      whaapy_event_id: eventId,
      whaapy_business_id: businessId,
      received_at: receivedAt,
      source: "endpoint",
    } as Json,
  });

  // 6. Dedup atómico (después del audit edge para que retransmisiones
  //    queden visibles vía `whaapy_webhook_deduped`).
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
    await safeAuditAtEdge(org.id as UUID, {
      eventType: "whaapy_webhook_deduped",
      payload: {
        topic,
        whaapy_event_id: eventId,
        whaapy_business_id: businessId,
        received_at: receivedAt,
      } as Json,
    });
    return new NextResponse("ok", { status: 200, headers: { "x-centrhub-dedup": "hit" } });
  }

  // 7. Topic → evento Inngest. Topic no soportado = audit + 200.
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

  // 8. Encolar a Inngest.
  try {
    await getInngestClient().send({
      name: inngestEvent,
      data: envelope,
    });
  } catch (err) {
    const errMsg = (err as Error).message;
    // eslint-disable-next-line no-console
    console.error("whaapy_webhook_enqueue_failed", {
      topic,
      eventId,
      err: errMsg,
    });
    await safeAuditAtEdge(org.id as UUID, {
      eventType: "whaapy_webhook_enqueue_failed",
      payload: {
        topic,
        whaapy_event_id: eventId,
        whaapy_business_id: businessId,
        error: errMsg,
      } as Json,
    });
    return new NextResponse("enqueue_failed", { status: 503 });
  }

  return new NextResponse("ok", { status: 200, headers: { "x-centrhub-dedup": "miss" } });
}

function cryptoRandomFallback(): string {
  return `local-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Audit a nivel endpoint con tenant context. Nunca bloquea la
 * respuesta HTTP — si el insert falla, lo deja en console.error y
 * sigue (el alternativo sería 500 a Whaapy, peor que perder un audit).
 */
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
    console.error("whaapy_endpoint_audit_failed", {
      event_type: input.eventType,
      err: (err as Error).message,
    });
  }
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
