import { DateTime } from "luxon";
import type { TimelineCategory } from "@/lib/services/timeline-catalog";
import type { ISODateString } from "@/lib/types/database";

/**
 * Resumen de entrada del cliente (punto 24) — módulo PURO.
 *
 * Lo que se pidió en la junta fue "saber exactamente dónde está el cliente".
 * La bitácora cuenta la historia completa; esto la responde de un vistazo,
 * arriba, sin tener que leerla: cuándo entró, por dónde, cuánto tardó el
 * primer avance, cuándo fue lo último y cuántos mensajes le ha mandado la
 * plataforma.
 *
 * El "ahora" entra como parámetro y la zona también: un "hace 3 días" que se
 * calcula con el reloj del servidor en UTC se corre de día en la primera hora
 * de la mañana.
 */

/** Lo mínimo que la función necesita de un evento — no la fila entera. */
export interface JourneyEvent {
  occurredAt: ISODateString;
  kind: string;
  category: TimelineCategory;
  meta?: Record<string, unknown>;
}

export interface JourneyContact {
  createdAt: ISODateString;
  isOutbound: boolean;
  hasWhaapy: boolean;
  hasShopify: boolean;
}

export type EntryChannel =
  | "outbound"
  | "whatsapp"
  | "formulario"
  | "shopify"
  | "manual"
  | "desconocido";

export const ENTRY_CHANNEL_LABELS: Record<EntryChannel, string> = {
  outbound: "Prospección (outbound)",
  whatsapp: "WhatsApp",
  formulario: "Formulario web",
  shopify: "Compra o alta en Shopify",
  manual: "Captura manual",
  desconocido: "Sin determinar",
};

export interface ContactJourney {
  entryChannel: EntryChannel;
  entryAt: ISODateString;
  /** Días desde que entró. */
  daysSinceEntry: number;
  /**
   * Días entre la entrada y el primer avance de etapa. null si todavía no
   * se ha movido de donde nació — que es información, no un hueco.
   */
  daysToFirstMove: number | null;
  lastEventAt: ISODateString | null;
  /** Días desde el último movimiento registrado. */
  daysSinceLastEvent: number | null;
  /** Mensajes que la PLATAFORMA le envió (no la conversación de WhatsApp). */
  messagesSent: number;
  /** Total de hechos en la bitácora. */
  eventCount: number;
}

/**
 * De dónde salió el contacto.
 *
 * El orden de precedencia no es arbitrario: `is_outbound` es la fuente de
 * verdad declarada (0040) y gana sobre cualquier inferencia; después manda
 * lo que diga la bitácora, que es un hecho fechado; y solo al final se
 * infiere de qué identidades externas tiene, que es lo más débil (un lead de
 * WhatsApp acaba con identidad de Shopify en cuanto alguien le cotiza).
 */
function deriveChannel(
  contact: JourneyContact,
  events: JourneyEvent[],
): EntryChannel {
  if (contact.isOutbound) return "outbound";

  // Del más viejo al más nuevo: la entrada es el primer hecho, no el último.
  const ascending = [...events].sort((a, b) =>
    a.occurredAt < b.occurredAt ? -1 : 1,
  );
  for (const ev of ascending) {
    if (ev.kind !== "lead_created") continue;
    const type = ev.meta?.event_type;
    if (type === "whaapy_contact_created_from_conversation") return "whatsapp";
    const source = ev.meta?.source;
    if (source === "webhook") return "formulario";
    if (source === "manual") return "manual";
    if (source === "whaapy") return "whatsapp";
    if (source === "shopify") return "shopify";
    return "formulario";
  }

  if (contact.hasWhaapy && !contact.hasShopify) return "whatsapp";
  if (contact.hasShopify && !contact.hasWhaapy) return "shopify";
  return "desconocido";
}

const daysBetween = (
  fromISO: string,
  toISO: string,
  zone: string,
): number | null => {
  const from = DateTime.fromISO(fromISO, { zone });
  const to = DateTime.fromISO(toISO, { zone });
  if (!from.isValid || !to.isValid) return null;
  return Math.max(
    Math.floor(to.startOf("day").diff(from.startOf("day"), "days").days),
    0,
  );
};

export function summarizeContactJourney(input: {
  contact: JourneyContact;
  events: JourneyEvent[];
  nowISO: ISODateString;
  zone: string;
}): ContactJourney {
  const { contact, events, nowISO, zone } = input;

  const ascending = [...events].sort((a, b) =>
    a.occurredAt < b.occurredAt ? -1 : 1,
  );
  // La entrada es la más vieja entre el alta del contacto y su primer hecho:
  // un contacto rehidratado desde Shopify puede tener eventos anteriores a
  // su propia fila.
  const firstEventAt = ascending[0]?.occurredAt ?? null;
  const entryAt =
    firstEventAt !== null && firstEventAt < contact.createdAt
      ? firstEventAt
      : contact.createdAt;

  // Primer avance = el primer cambio de etapa POSTERIOR a la entrada. El
  // movimiento de nacimiento (la tarjeta aterrizando en su etapa inicial)
  // no es un avance: ocurre en el mismo instante en que entró.
  const firstMove = ascending.find(
    (e) => e.kind === "stage_change" && e.occurredAt > entryAt,
  );

  const lastEventAt = ascending.length > 0
    ? ascending[ascending.length - 1]!.occurredAt
    : null;

  return {
    entryChannel: deriveChannel(contact, events),
    entryAt,
    daysSinceEntry: daysBetween(entryAt, nowISO, zone) ?? 0,
    daysToFirstMove: firstMove
      ? daysBetween(entryAt, firstMove.occurredAt, zone)
      : null,
    lastEventAt,
    daysSinceLastEvent: lastEventAt
      ? daysBetween(lastEventAt, nowISO, zone)
      : null,
    messagesSent: events.filter((e) => e.kind === "message_sent").length,
    eventCount: events.length,
  };
}
