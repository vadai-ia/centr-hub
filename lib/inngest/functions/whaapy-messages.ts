import "server-only";
import {
  getInngestClient,
  type WhaapyWebhookEnvelope,
} from "@/lib/inngest/client";
import { runWhaapyWebhookWorker } from "@/lib/inngest/helpers";
import {
  WhaapyMessageReceivedPayloadSchema,
  WhaapyMessageSentPayloadSchema,
} from "@/lib/whaapy/mappers";
import {
  findContactByWhaapyContactId,
  findContactByPhoneOrEmail,
} from "@/lib/db/contacts";
import { recordWhaapyMessage } from "@/lib/db/whaapy-messages";
import { normalizePhone } from "@/lib/services/identity-matching";
import { readOrganizationPhoneCountry } from "@/lib/services/organization-phone-country";
import { getOrganizationById } from "@/lib/db/organizations";
import type { ContactRow, ISODateString, UUID } from "@/lib/types/database";

/**
 * Mensajes de WhatsApp (0058) — solo METADATA, para medir cuánto tarda cada
 * asesor en contestar.
 *
 * Qué NO hace, a propósito:
 *   - No guarda el contenido del mensaje (ver la migración).
 *   - No crea contactos. `conversation.created` ya cubre la auto-hidratación
 *     del lead orgánico; duplicar esa lógica aquí daría dos caminos de
 *     creación compitiendo por el mismo contacto. Un mensaje cuyo contacto
 *     todavía no existe se registra igual: la métrica se calcula por
 *     CONVERSACIÓN, así que no pierde nada.
 *   - No dispara R12 ni toca el pipeline. Es un registro de observación.
 *
 * Volumen: es el evento más frecuente del sistema con diferencia. Por eso el
 * worker hace como mucho dos lecturas (contacto + config de la org) y un
 * insert, y nunca una llamada saliente a Whaapy.
 */

const inngest = getInngestClient();

/**
 * Whaapy fecha los mensajes de dos maneras distintas según el evento:
 * `message.received` reenvía el objeto de Meta, donde el timestamp es epoch
 * en SEGUNDOS y viaja como string; `message.sent` es propio de Whaapy y usa
 * ISO. Tratar el epoch como ISO daría una fecha inválida y el mensaje
 * aterrizaría con la hora de recepción, falseando el tiempo de respuesta.
 */
function resolveOccurredAt(
  candidate: string | null | undefined,
  fallback: ISODateString,
): ISODateString {
  if (!candidate) return fallback;
  if (/^\d+$/.test(candidate)) {
    const secs = Number(candidate);
    if (!Number.isFinite(secs) || secs <= 0) return fallback;
    return new Date(secs * 1000).toISOString() as ISODateString;
  }
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime())
    ? fallback
    : (parsed.toISOString() as ISODateString);
}

async function resolveContact(
  organizationId: UUID,
  whaapyContactId: string | null | undefined,
  phone: string | null | undefined,
): Promise<ContactRow | null> {
  if (whaapyContactId) {
    const byId = await findContactByWhaapyContactId(whaapyContactId);
    if (byId) return byId;
  }
  if (phone) {
    const org = await getOrganizationById(organizationId);
    const e164 = normalizePhone(
      phone,
      readOrganizationPhoneCountry(org?.config ?? null) as never,
    );
    if (e164) return await findContactByPhoneOrEmail({ phone: e164 });
  }
  return null;
}

// ============================================================
// 1) message.received — el cliente escribió (abre el turno)
// ============================================================

export const whaapyMessageReceived = inngest.createFunction(
  {
    id: "whaapy-message-received",
    retries: 3,
    triggers: [{ event: "whaapy/message.received" }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as WhaapyWebhookEnvelope;
    return runWhaapyWebhookWorker(envelope, "message.received", async (env) => {
      const parsed = WhaapyMessageReceivedPayloadSchema.parse(env.payload);
      const data = parsed.data;

      const contact = await resolveContact(
        env.organizationId,
        data.contact_id,
        data.message?.from,
      );

      const inserted = await recordWhaapyMessage({
        whaapyMessageId: data.whaapy_message_id,
        conversationId: data.conversation_id,
        contactId: (contact?.id as UUID | undefined) ?? null,
        direction: "inbound",
        // El cliente nunca es el bot. El campo solo tiene sentido en outbound.
        sentByAi: false,
        // En un ENTRANTE esto no es "quién trabajó" sino DE QUIÉN era el
        // cliente que escribió. Es lo que permite dos cosas: recortar la
        // tarjeta a lo suyo cuando la mira un vendedor, y decirle a quién le
        // quedó una conversación sin contestar.
        advisorMembershipId:
          (contact?.assigned_advisor_id as UUID | null | undefined) ?? null,
        occurredAt: resolveOccurredAt(
          data.message?.timestamp ?? parsed.timestamp,
          env.receivedAt as ISODateString,
        ),
      });

      return { inserted, duplicate: !inserted };
    });
  },
);

// ============================================================
// 2) message.sent — el negocio escribió (puede cerrar el turno)
// ============================================================

export const whaapyMessageSent = inngest.createFunction(
  {
    id: "whaapy-message-sent",
    retries: 3,
    triggers: [{ event: "whaapy/message.sent" }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as WhaapyWebhookEnvelope;
    return runWhaapyWebhookWorker(envelope, "message.sent", async (env) => {
      const parsed = WhaapyMessageSentPayloadSchema.parse(env.payload);
      const data = parsed.data;

      // Whaapy emite `message.sent` DOS veces por mensaje con el MISMO
      // message_id: el payload completo y, un segundo después, una
      // actualización de estado que NO trae `sent_by_ai`. El índice único
      // deduplica y gana el que llegue primero — y el orden entre dos
      // requests HTTP con sus workers en paralelo no está garantizado.
      //
      // Si ganara el de estado, el mensaje se guardaría como HUMANO por
      // defecto. Un mensaje del bot contando como respuesta del asesor es
      // exactamente lo que esta métrica existe para evitar: daría respuesta
      // instantánea a todo el mundo. Sin autoría no se guarda.
      if (data.sent_by_ai === null || data.sent_by_ai === undefined) {
        return { skipped: true, reason: "status_update_without_authorship" };
      }
      const sentByAi = data.sent_by_ai === true;

      // El contacto solo se busca para los mensajes HUMANOS: es la única vía
      // de saber quién contestó, y el bot manda muchos más mensajes que las
      // personas. Buscarlo también para el bot sería una lectura por cada
      // respuesta automática sin nada que hacer con ella.
      const contact = sentByAi
        ? null
        : await resolveContact(env.organizationId, null, data.to);

      const inserted = await recordWhaapyMessage({
        whaapyMessageId: data.message_id,
        conversationId: data.conversation_id,
        contactId: (contact?.id as UUID | undefined) ?? null,
        direction: "outbound",
        sentByAi,
        // `message.sent` NO identifica al humano que escribió: lo más cercano
        // es quién tiene el contacto asignado AHORA, y por eso se congela
        // aquí. Resolverlo al consultar reportaría las respuestas de ayer a
        // cargo del asesor de hoy.
        advisorMembershipId:
          (contact?.assigned_advisor_id as UUID | null | undefined) ?? null,
        occurredAt: resolveOccurredAt(
          data.timestamp ?? parsed.timestamp,
          env.receivedAt as ISODateString,
        ),
      });

      return { inserted, duplicate: !inserted, sentByAi };
    });
  },
);

export const whaapyMessageFunctions = [
  whaapyMessageReceived,
  whaapyMessageSent,
];
