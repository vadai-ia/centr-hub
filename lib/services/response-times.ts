import { DateTime } from "luxon";
import type { ISODateString, UUID } from "@/lib/types/database";
import type { ResponseTimes, AdvisorResponseTime } from "@/lib/types/dashboard";

/**
 * Tiempo de respuesta del asesor — módulo PURO.
 *
 * La pregunta de la dirección fue "¿cuánto tarda cada comercial en
 * contestar?". Hasta ahora la plataforma medía el tiempo al primer
 * MOVIMIENTO de la tarjeta (`lead-timings`), que es otra cosa: un asesor
 * puede contestar en dos minutos por WhatsApp y no tocar el CRM en dos días.
 *
 * Todo lo que importa aquí es lógica temporal, así que vive separado de la
 * lectura: probarlo contra la BD sería probar Postgres en vez de la regla.
 */

export interface MessageEvent {
  conversationId: string;
  occurredAt: ISODateString;
  direction: "inbound" | "outbound";
  /** Solo aplica a outbound. Un mensaje del bot NO cierra el turno. */
  sentByAi: boolean;
  /**
   * Quién tenía el contacto asignado EN ESE MOMENTO. En un outbound humano
   * es lo más cercano a "quién contestó" (Whaapy no identifica al humano);
   * en un inbound es de quién era el cliente que escribió, que es lo que
   * permite decir a quién le quedó una conversación sin responder.
   */
  advisorMembershipId: UUID | null;
}

/**
 * A quién se reportan los tiempos. Es un tipo APARTE del `Scope` del
 * dashboard a propósito: el emparejamiento de turnos SIEMPRE ocurre sobre
 * todos los mensajes de la conversación —recortar la entrada partiría turnos
 * cuya respuesta la dio alguien más— y el recorte se aplica al final, sobre
 * los resultados.
 */
export type ResponseScope = UUID | null | "all";

export interface ComputeResponseTimesInput {
  messages: MessageEvent[];
  /**
   * Un vendedor ve SOLO lo suyo. Sin esto, la tarjeta expondría los tiempos
   * de toda la organización a cualquiera que entre al dashboard.
   */
  scope: ResponseScope;
  /**
   * Los mensajes vienen con un margen hacia atrás para no partir turnos que
   * abrieron justo antes del periodo. Solo cuentan las respuestas cuya
   * marca cae DENTRO de la ventana; el margen únicamente permite encontrar
   * el mensaje del cliente que las originó.
   */
  periodStart: ISODateString;
  periodEnd: ISODateString;
}

/**
 * Mediana Y promedio, los dos — misma razón que en `lead-timings`: una sola
 * conversación olvidada un fin de semana arrastra el promedio y hace parecer
 * lento a todo el equipo, mientras que la mediana sola esconde que existe
 * esa cola. Mostrar uno nada más miente de un modo distinto cada vez.
 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function minutesBetween(fromISO: string, toISO: string): number | null {
  const from = DateTime.fromISO(fromISO);
  const to = DateTime.fromISO(toISO);
  if (!from.isValid || !to.isValid) return null;
  // Un reloj corrido entre Whaapy y la plataforma no debe producir tiempos
  // negativos que arrastren la media hacia abajo.
  return Math.max(to.diff(from, "minutes").minutes, 0);
}

/** Mismo criterio que el `matchScope` del dashboard: null = sin asesor. */
function enScope(advisorId: UUID | null, scope: ResponseScope): boolean {
  if (scope === "all") return true;
  return advisorId === scope;
}

interface Respuesta {
  minutes: number;
  advisorMembershipId: UUID | null;
}

export function computeResponseTimes(
  input: ComputeResponseTimesInput,
): ResponseTimes {
  // Agrupar por conversación: el emparejamiento es dentro de un hilo. Mezclar
  // hilos aparearía el mensaje de un cliente con la respuesta a otro.
  const porConversacion = new Map<string, MessageEvent[]>();
  for (const m of input.messages) {
    const lista = porConversacion.get(m.conversationId);
    if (lista) lista.push(m);
    else porConversacion.set(m.conversationId, [m]);
  }

  const respuestas: Respuesta[] = [];
  let sinResponder = 0;

  for (const mensajes of Array.from(porConversacion.values())) {
    // Empate de marca: el ENTRANTE va primero. No es capricho de orden —
    // Whaapy fecha los dos eventos con relojes distintos y el del cliente
    // llega con resolución de SEGUNDOS (formato de Meta). Una respuesta
    // humana inmediata puede empatar con la pregunta, y sin el desempate el
    // orden queda al azar: la respuesta se vería como mensaje suelto y la
    // pregunta como conversación sin contestar.
    const ordenados = [...mensajes].sort((a, b) => {
      if (a.occurredAt !== b.occurredAt) {
        return a.occurredAt < b.occurredAt ? -1 : 1;
      }
      if (a.direction === b.direction) return 0;
      return a.direction === "inbound" ? -1 : 1;
    });

    // Un "turno" abre con el mensaje del cliente y cierra con la primera
    // respuesta HUMANA. Los mensajes del cliente que llegan con un turno ya
    // abierto no abren otro: tres mensajes seguidos del cliente son una sola
    // espera, y contarlos por separado triplicaría el peso de quien escribe
    // mucho.
    let abiertoEn: string | null = null;
    let abiertoDe: UUID | null = null;

    for (const m of ordenados) {
      if (m.direction === "inbound") {
        if (abiertoEn === null) {
          abiertoEn = m.occurredAt;
          abiertoDe = m.advisorMembershipId;
        }
        continue;
      }
      // El bot no cierra el turno: contesta en segundos y dejaría a todos los
      // asesores con respuesta instantánea.
      if (m.sentByAi) continue;
      // Respuesta humana sin mensaje previo del cliente: el asesor inició la
      // conversación. No es una respuesta, no mide nada.
      if (abiertoEn === null) continue;

      // Solo cuenta si la RESPUESTA cae en el periodo. El margen hacia atrás
      // existe para encontrar el mensaje que la originó, no para colar
      // respuestas de antes de la ventana.
      // El turno se CIERRA con esta respuesta aunque no entre en el recorte:
      // si se descartara antes de cerrar, la siguiente respuesta del hilo se
      // mediría contra un mensaje del cliente ya atendido.
      if (
        m.occurredAt >= input.periodStart &&
        m.occurredAt <= input.periodEnd &&
        enScope(m.advisorMembershipId, input.scope)
      ) {
        const mins = minutesBetween(abiertoEn, m.occurredAt);
        if (mins !== null) {
          respuestas.push({
            minutes: mins,
            advisorMembershipId: m.advisorMembershipId,
          });
        }
      }
      abiertoEn = null;
      abiertoDe = null;
    }

    // Turno que quedó abierto al final de la ventana: nadie contestó. Es el
    // dato que delata al cliente ignorado, y omitirlo haría ver mejor al
    // equipo cuanto MÁS gente deje sin responder.
    if (
      abiertoEn !== null &&
      abiertoEn >= input.periodStart &&
      abiertoEn <= input.periodEnd &&
      enScope(abiertoDe, input.scope)
    ) {
      sinResponder += 1;
    }
  }

  const porAsesor = new Map<string, number[]>();
  for (const r of respuestas) {
    const key = r.advisorMembershipId ?? "";
    const lista = porAsesor.get(key);
    if (lista) lista.push(r.minutes);
    else porAsesor.set(key, [r.minutes]);
  }

  const byAdvisor: AdvisorResponseTime[] = Array.from(porAsesor.entries())
    .map(([key, mins]) => ({
      advisorMembershipId: (key === "" ? null : key) as UUID | null,
      responses: mins.length,
      medianMinutes: median(mins),
      averageMinutes: average(mins),
    }))
    // Por mediana ascendente: quien contesta más rápido, arriba. Los que no
    // tienen mediana (imposible aquí, pero el tipo lo admite) al final.
    .sort((a, b) => (a.medianMinutes ?? Infinity) - (b.medianMinutes ?? Infinity));

  const todos = respuestas.map((r) => r.minutes);
  return {
    responses: todos.length,
    medianMinutes: median(todos),
    averageMinutes: average(todos),
    unanswered: sinResponder,
    byAdvisor,
  };
}

/** "8 min", "3 h", "2 días" — para una tarjeta, no para un reporte. */
export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 1) return "menos de 1 min";
  if (minutes < 90) {
    const m = Math.round(minutes);
    return m === 1 ? "1 min" : `${m} min`;
  }
  const horas = minutes / 60;
  if (horas < 48) {
    const h = Math.round(horas);
    return h === 1 ? "1 h" : `${h} h`;
  }
  const d = Math.round(horas / 24);
  return d === 1 ? "1 día" : `${d} días`;
}
