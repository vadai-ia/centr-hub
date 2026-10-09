import { DateTime } from "luxon";
import type { EntryChannel } from "@/lib/services/contact-journey";
import type { ISODateString, UUID } from "@/lib/types/database";
import type { LeadTimings, ChannelShare } from "@/lib/types/dashboard";

/**
 * Tiempos y origen de los leads (punto 24, segunda mitad) — módulo PURO.
 *
 * El embudo (punto 9) dice DÓNDE se cae el proceso. Esto dice CUÁNTO tarda y
 * POR DÓNDE entra la gente: las dos preguntas que la dirección pidió poder
 * contestar "basado en lo sucedido con cada uno de los clientes".
 *
 * Trabaja sobre la MISMA cohorte de personas que el embudo, así que los dos
 * números siempre hablan del mismo grupo.
 */

export interface TimingCohortMember {
  contactId: UUID;
  /** Cuándo entró como lead (entrada a la etapa inicial). */
  entryAt: ISODateString;
  /** Marca declarada (0040) — gana sobre cualquier inferencia de canal. */
  isOutbound: boolean;
}

export interface TimingHistoryEntry {
  contactId: UUID;
  position: number;
  occurredAt: ISODateString;
}

export interface ComputeLeadTimingsInput {
  cohort: TimingCohortMember[];
  /** Historial de etapas de la cohorte, ya con la posición resuelta. */
  history: TimingHistoryEntry[];
  /** Posición de la etapa inicial: por encima de ella es avance. */
  initialPosition: number;
  /** Canal por persona, de la bitácora (`lead_created`). Lo que no esté, se infiere. */
  channelByContact: Map<UUID, EntryChannel>;
  zone: string;
}

/**
 * Mediana y no solo promedio: un lead que lleva meses sin tocarse arrastra el
 * promedio y hace parecer lento a todo el equipo. La mediana dice qué pasa en
 * el caso típico, que es lo que se puede corregir.
 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function hoursBetween(
  fromISO: string,
  toISO: string,
  zone: string,
): number | null {
  const from = DateTime.fromISO(fromISO, { zone });
  const to = DateTime.fromISO(toISO, { zone });
  if (!from.isValid || !to.isValid) return null;
  const hours = to.diff(from, "hours").hours;
  // Un avance "anterior" a la entrada es dato sucio (re-fechas de Shopify,
  // migración 0025): se trata como inmediato, no como negativo.
  return Math.max(hours, 0);
}

export function computeLeadTimings(
  input: ComputeLeadTimingsInput,
): LeadTimings {
  const entryByContact = new Map<UUID, string>();
  for (const m of input.cohort) {
    // Si alguien entró como lead dos veces en el periodo, cuenta la primera.
    const prev = entryByContact.get(m.contactId);
    if (prev === undefined || m.entryAt < prev) {
      entryByContact.set(m.contactId, m.entryAt);
    }
  }

  // Primer avance por persona: el hecho más VIEJO por encima de la etapa
  // inicial y posterior a su entrada. Los movimientos simultáneos a la
  // entrada (la tarjeta aterrizando donde nació) no son avance.
  const firstMoveByContact = new Map<UUID, string>();
  for (const h of input.history) {
    const entry = entryByContact.get(h.contactId);
    if (entry === undefined) continue;
    if (h.position <= input.initialPosition) continue;
    if (h.occurredAt <= entry) continue;
    const prev = firstMoveByContact.get(h.contactId);
    if (prev === undefined || h.occurredAt < prev) {
      firstMoveByContact.set(h.contactId, h.occurredAt);
    }
  }

  const horas: number[] = [];
  let sinAvanzar = 0;
  for (const [contactId, entry] of Array.from(entryByContact.entries())) {
    const move = firstMoveByContact.get(contactId);
    if (move === undefined) {
      sinAvanzar += 1;
      continue;
    }
    const h = hoursBetween(entry, move, input.zone);
    if (h !== null) horas.push(h);
  }

  // Reparto por canal. El outbound declarado gana; lo demás sale de la
  // bitácora y, si no hay, queda "Sin determinar" — inventar un canal aquí
  // es lo que vuelve inservible el reparto.
  const porCanal = new Map<EntryChannel, number>();
  for (const m of input.cohort) {
    if (!entryByContact.has(m.contactId)) continue;
    const canal: EntryChannel = m.isOutbound
      ? "outbound"
      : input.channelByContact.get(m.contactId) ?? "desconocido";
    porCanal.set(canal, (porCanal.get(canal) ?? 0) + 1);
  }
  const total = entryByContact.size;
  const byChannel: ChannelShare[] = Array.from(porCanal.entries())
    .map(([channel, count]) => ({
      channel,
      count,
      share: total > 0 ? count / total : null,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    cohortSize: total,
    medianHoursToFirstMove: median(horas),
    averageHoursToFirstMove:
      horas.length > 0 ? horas.reduce((a, b) => a + b, 0) / horas.length : null,
    movedCount: horas.length,
    withoutMove: sinAvanzar,
    byChannel,
  };
}

/** "3 h", "2 d", "menos de 1 h" — para una tarjeta, no para un reporte. */
export function formatElapsed(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 1) return "menos de 1 h";
  if (hours < 48) {
    const h = Math.round(hours);
    return h === 1 ? "1 h" : `${h} h`;
  }
  const d = Math.round(hours / 24);
  return d === 1 ? "1 día" : `${d} días`;
}
