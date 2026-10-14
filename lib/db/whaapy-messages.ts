import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { fetchAllPaged, type RangeableQuery } from "@/lib/db/paginate";
import type { MessageEvent } from "@/lib/services/response-times";
import type { ISODateString, UUID } from "@/lib/types/database";

/**
 * Metadata de mensajes de WhatsApp (0058). Toda función opera DENTRO de
 * `withTenantContext(...)`.
 *
 * La tabla NO guarda el contenido del mensaje — ver el comentario de la
 * migración. Lo que se persiste es cuándo, en qué sentido, si lo mandó el
 * bot y quién tenía el contacto asignado en ese momento.
 */

export interface RecordWhaapyMessageInput {
  whaapyMessageId: string;
  conversationId: string;
  contactId: UUID | null;
  direction: "inbound" | "outbound";
  sentByAi: boolean;
  advisorMembershipId: UUID | null;
  occurredAt: ISODateString;
}

/**
 * Inserta el mensaje. Idempotente por el índice único (org, whaapy_message_id):
 * un reintento del webhook no puede duplicar la fila y falsear el conteo.
 *
 * Devuelve `false` cuando la fila ya existía, para que el worker lo pueda
 * reportar en su resultado sin tratarlo como error.
 */
export async function recordWhaapyMessage(
  input: RecordWhaapyMessageInput,
): Promise<boolean> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("whaapy_messages")
    .upsert(
      {
        organization_id: organizationId,
        whaapy_message_id: input.whaapyMessageId,
        conversation_id: input.conversationId,
        contact_id: input.contactId,
        direction: input.direction,
        sent_by_ai: input.sentByAi,
        advisor_membership_id: input.advisorMembershipId,
        occurred_at: input.occurredAt,
      },
      { onConflict: "organization_id,whaapy_message_id", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Mensajes de la organización en una ventana, para emparejar turnos.
 *
 * `from` llega con un margen hacia atrás respecto al periodo que se reporta:
 * un cliente que escribió el día 31 del mes anterior y recibió respuesta el
 * día 1 aparecería, sin ese margen, como una respuesta sin pregunta — y el
 * emparejamiento la descartaría en silencio. El recorte al periodo real lo
 * hace `computeResponseTimes`, que solo cuenta respuestas dentro de él.
 *
 * Paginado obligatorio: PostgREST corta en 1000 filas y una organización con
 * tráfico de WhatsApp pasa de eso en días, no en meses. Sin paginar, la
 * mediana se calcularía sobre una muestra arbitraria sin ningún error visible.
 */
export async function listMessageEventsInWindow(
  from: ISODateString,
  to: ISODateString,
): Promise<MessageEvent[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const rows = await fetchAllPaged<{
    conversation_id: string;
    occurred_at: string;
    direction: "inbound" | "outbound";
    sent_by_ai: boolean;
    advisor_membership_id: UUID | null;
  }>(
    () =>
      supabase
        .from("whaapy_messages")
        .select(
          "conversation_id, occurred_at, direction, sent_by_ai, advisor_membership_id",
        )
        .eq("organization_id", organizationId)
        .gte("occurred_at", from)
        .lte("occurred_at", to)
        .order("occurred_at", { ascending: true }) as unknown as RangeableQuery,
  );
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    occurredAt: r.occurred_at as ISODateString,
    direction: r.direction,
    sentByAi: r.sent_by_ai,
    advisorMembershipId: r.advisor_membership_id,
  }));
}

/**
 * Fecha del mensaje más viejo registrado. La tabla arranca VACÍA el día del
 * despliegue y no hay forma de reconstruir hacia atrás, así que la tarjeta
 * necesita poder decir desde cuándo mide en vez de insinuar que un periodo
 * anterior no tuvo conversaciones.
 */
export async function getFirstMessageAt(): Promise<ISODateString | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("whaapy_messages")
    .select("occurred_at")
    .eq("organization_id", organizationId)
    .order("occurred_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data?.occurred_at as ISODateString | undefined) ?? null;
}
