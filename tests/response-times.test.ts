import { describe, expect, it } from "vitest";
import {
  computeResponseTimes,
  formatMinutes,
  type MessageEvent,
} from "@/lib/services/response-times";
import type { ISODateString, UUID } from "@/lib/types/database";

/**
 * Tiempo de respuesta del asesor (0058).
 *
 * Todo lo que importa aquí es lógica temporal, así que se prueba sobre el
 * módulo puro: contra la BD estaríamos probando Postgres en vez de la regla.
 */

const ANA = "11111111-1111-1111-1111-111111111111" as UUID;
const BETO = "22222222-2222-2222-2222-222222222222" as UUID;

const PERIODO = {
  periodStart: "2026-10-01T00:00:00.000Z" as ISODateString,
  periodEnd: "2026-10-31T23:59:59.999Z" as ISODateString,
};

function entrante(
  conv: string,
  iso: string,
  advisor: UUID | null = ANA,
): MessageEvent {
  return {
    conversationId: conv,
    occurredAt: iso as ISODateString,
    direction: "inbound",
    sentByAi: false,
    advisorMembershipId: advisor,
  };
}

function saliente(
  conv: string,
  iso: string,
  opts: { ai?: boolean; advisor?: UUID | null } = {},
): MessageEvent {
  return {
    conversationId: conv,
    occurredAt: iso as ISODateString,
    direction: "outbound",
    sentByAi: opts.ai ?? false,
    // `?? ANA` convertiría un `advisor: null` explícito en ANA y el caso
    // "sin asesor" nunca se probaría.
    advisorMembershipId: "advisor" in opts ? opts.advisor! : ANA,
  };
}

describe("primera respuesta humana", () => {
  it("mide del mensaje del cliente a la respuesta", () => {
    const r = computeResponseTimes({
      scope: "all",
      ...PERIODO,
      messages: [
        entrante("c1", "2026-10-05T10:00:00.000Z"),
        saliente("c1", "2026-10-05T10:30:00.000Z"),
      ],
    });
    expect(r.responses).toBe(1);
    expect(r.medianMinutes).toBe(30);
    expect(r.unanswered).toBe(0);
  });

  it("el agente de IA NO cierra el turno", () => {
    // Es la razón de ser de `sent_by_ai`: el bot contesta en segundos y
    // dejaría a todos los asesores con respuesta instantánea.
    const r = computeResponseTimes({
      scope: "all",
      ...PERIODO,
      messages: [
        entrante("c1", "2026-10-05T10:00:00.000Z"),
        saliente("c1", "2026-10-05T10:00:05.000Z", { ai: true }),
        saliente("c1", "2026-10-05T11:00:00.000Z"),
      ],
    });
    expect(r.responses).toBe(1);
    expect(r.medianMinutes).toBe(60);
  });

  it("varios mensajes seguidos del cliente son UNA sola espera", () => {
    // Contarlos por separado triplicaría el peso de quien escribe mucho, y
    // los dos últimos medirían contra un reloj que ya estaba corriendo.
    const r = computeResponseTimes({
      scope: "all",
      ...PERIODO,
      messages: [
        entrante("c1", "2026-10-05T10:00:00.000Z"),
        entrante("c1", "2026-10-05T10:05:00.000Z"),
        entrante("c1", "2026-10-05T10:10:00.000Z"),
        saliente("c1", "2026-10-05T11:00:00.000Z"),
      ],
    });
    expect(r.responses).toBe(1);
    expect(r.medianMinutes).toBe(60);
  });

  it("un mensaje del asesor SIN pregunta previa no es una respuesta", () => {
    // El asesor inició la conversación. No mide nada.
    const r = computeResponseTimes({
      scope: "all",
      ...PERIODO,
      messages: [
        saliente("c1", "2026-10-05T10:00:00.000Z"),
        saliente("c1", "2026-10-05T10:01:00.000Z"),
      ],
    });
    expect(r.responses).toBe(0);
    expect(r.medianMinutes).toBeNull();
  });

  it("no empareja mensajes de conversaciones distintas", () => {
    const r = computeResponseTimes({
      scope: "all",
      ...PERIODO,
      messages: [
        entrante("c1", "2026-10-05T10:00:00.000Z"),
        saliente("c2", "2026-10-05T10:01:00.000Z"),
        saliente("c1", "2026-10-05T12:00:00.000Z"),
      ],
    });
    expect(r.responses).toBe(1);
    expect(r.medianMinutes).toBe(120);
  });

  it("ordena los mensajes aunque lleguen al revés", () => {
    const r = computeResponseTimes({
      scope: "all",
      ...PERIODO,
      messages: [
        saliente("c1", "2026-10-05T10:30:00.000Z"),
        entrante("c1", "2026-10-05T10:00:00.000Z"),
      ],
    });
    expect(r.medianMinutes).toBe(30);
  });
});

describe("mediana y promedio, los dos", () => {
  it("el promedio delata la cola larga que la mediana esconde", () => {
    // 10, 10, 10 min y una de 24 h: la mediana dice que el caso típico son
    // 10 minutos, el promedio que hay algo olvidado. Mostrar uno solo miente
    // de un modo distinto cada vez.
    const msgs: MessageEvent[] = [];
    for (let i = 1; i <= 3; i++) {
      msgs.push(entrante(`c${i}`, `2026-10-0${i}T10:00:00.000Z`));
      msgs.push(saliente(`c${i}`, `2026-10-0${i}T10:10:00.000Z`));
    }
    msgs.push(entrante("c9", "2026-10-09T10:00:00.000Z"));
    msgs.push(saliente("c9", "2026-10-10T10:00:00.000Z"));

    const r = computeResponseTimes({ scope: "all", ...PERIODO, messages: msgs });
    expect(r.responses).toBe(4);
    expect(r.medianMinutes).toBe(10);
    expect(r.averageMinutes).toBeGreaterThan(300);
  });
});

describe("sin contestar", () => {
  it("cuenta al cliente que escribió y nadie respondió", () => {
    // Omitirlo haría ver MEJOR al equipo cuanta más gente deje colgada.
    const r = computeResponseTimes({
      scope: "all",
      ...PERIODO,
      messages: [entrante("c1", "2026-10-05T10:00:00.000Z")],
    });
    expect(r.responses).toBe(0);
    expect(r.unanswered).toBe(1);
  });

  it("un turno ya cerrado no cuenta como sin contestar", () => {
    const r = computeResponseTimes({
      scope: "all",
      ...PERIODO,
      messages: [
        entrante("c1", "2026-10-05T10:00:00.000Z"),
        saliente("c1", "2026-10-05T10:30:00.000Z"),
      ],
    });
    expect(r.unanswered).toBe(0);
  });

  it("el bot contestando NO salva el turno", () => {
    const r = computeResponseTimes({
      scope: "all",
      ...PERIODO,
      messages: [
        entrante("c1", "2026-10-05T10:00:00.000Z"),
        saliente("c1", "2026-10-05T10:00:03.000Z", { ai: true }),
      ],
    });
    expect(r.unanswered).toBe(1);
  });
});

describe("el margen hacia atrás encuentra la pregunta, no cuela respuestas", () => {
  it("una respuesta del periodo a una pregunta ANTERIOR sí cuenta", () => {
    // Sin el margen, esta respuesta sería una respuesta sin pregunta y se
    // descartaría en silencio.
    const r = computeResponseTimes({
      scope: "all",
      ...PERIODO,
      messages: [
        entrante("c1", "2026-09-30T23:00:00.000Z"),
        saliente("c1", "2026-10-01T01:00:00.000Z"),
      ],
    });
    expect(r.responses).toBe(1);
    expect(r.medianMinutes).toBe(120);
  });

  it("una respuesta ANTERIOR al periodo no se cuenta", () => {
    const r = computeResponseTimes({
      scope: "all",
      ...PERIODO,
      messages: [
        entrante("c1", "2026-09-20T10:00:00.000Z"),
        saliente("c1", "2026-09-20T10:30:00.000Z"),
      ],
    });
    expect(r.responses).toBe(0);
  });

  it("pero ESA respuesta sí cierra el turno", () => {
    // Si no cerrara, la siguiente respuesta del hilo se mediría contra un
    // mensaje del cliente que ya había sido atendido — daría días en vez de
    // minutos.
    const r = computeResponseTimes({
      scope: "all",
      ...PERIODO,
      messages: [
        entrante("c1", "2026-09-20T10:00:00.000Z"),
        saliente("c1", "2026-09-20T10:30:00.000Z"),
        entrante("c1", "2026-10-05T10:00:00.000Z"),
        saliente("c1", "2026-10-05T10:15:00.000Z"),
      ],
    });
    expect(r.responses).toBe(1);
    expect(r.medianMinutes).toBe(15);
  });

  it("una pregunta anterior sin respuesta no cuenta como sin contestar", () => {
    // No es del periodo que se está reportando.
    const r = computeResponseTimes({
      scope: "all",
      ...PERIODO,
      messages: [entrante("c1", "2026-09-20T10:00:00.000Z")],
    });
    expect(r.unanswered).toBe(0);
  });
});

describe("un vendedor ve SOLO lo suyo", () => {
  const MENSAJES: MessageEvent[] = [
    entrante("c1", "2026-10-05T10:00:00.000Z", ANA),
    saliente("c1", "2026-10-05T10:30:00.000Z", { advisor: ANA }),
    entrante("c2", "2026-10-06T10:00:00.000Z", BETO),
    saliente("c2", "2026-10-06T12:00:00.000Z", { advisor: BETO }),
    entrante("c3", "2026-10-07T10:00:00.000Z", BETO),
  ];

  it("con scope de un asesor solo cuentan SUS respuestas", () => {
    const r = computeResponseTimes({ scope: ANA, ...PERIODO, messages: MENSAJES });
    expect(r.responses).toBe(1);
    expect(r.medianMinutes).toBe(30);
  });

  it("y solo SUS conversaciones sin contestar", () => {
    const deAna = computeResponseTimes({ scope: ANA, ...PERIODO, messages: MENSAJES });
    const deBeto = computeResponseTimes({ scope: BETO, ...PERIODO, messages: MENSAJES });
    expect(deAna.unanswered).toBe(0);
    expect(deBeto.unanswered).toBe(1);
  });

  it("el desglose por asesor va del más rápido al más lento", () => {
    const r = computeResponseTimes({ scope: "all", ...PERIODO, messages: MENSAJES });
    expect(r.byAdvisor.map((a) => a.advisorMembershipId)).toEqual([ANA, BETO]);
    expect(r.byAdvisor[0]!.medianMinutes).toBe(30);
    expect(r.byAdvisor[1]!.medianMinutes).toBe(120);
  });

  it("las respuestas en conversaciones sin asesor quedan aparte", () => {
    const r = computeResponseTimes({
      scope: "all",
      ...PERIODO,
      messages: [
        entrante("c1", "2026-10-05T10:00:00.000Z", null),
        saliente("c1", "2026-10-05T10:05:00.000Z", { advisor: null }),
      ],
    });
    expect(r.byAdvisor).toHaveLength(1);
    expect(r.byAdvisor[0]!.advisorMembershipId).toBeNull();
  });
});

describe("datos sucios", () => {
  it("una respuesta FECHADA antes de la pregunta no inventa un negativo", () => {
    // Los mensajes se ordenan por marca, así que una respuesta con fecha
    // anterior queda ANTES: se lee como mensaje suelto del asesor y la
    // pregunta como pendiente. Nunca produce un tiempo negativo que
    // arrastre la media y haga ver al equipo más rápido de lo que es.
    const r = computeResponseTimes({
      scope: "all",
      ...PERIODO,
      messages: [
        entrante("c1", "2026-10-05T10:00:00.000Z"),
        saliente("c1", "2026-10-05T09:59:00.000Z"),
      ],
    });
    expect(r.responses).toBe(0);
    expect(r.unanswered).toBe(1);
  });

  it("una respuesta en el MISMO segundo cuenta como respuesta, no como hueco", () => {
    // El cliente llega con resolución de segundos (formato de Meta) y la
    // respuesta con la de Whaapy. Sin desempatar a favor del entrante, una
    // respuesta instantánea quedaría como conversación sin contestar.
    const r = computeResponseTimes({
      scope: "all",
      ...PERIODO,
      messages: [
        saliente("c1", "2026-10-05T10:00:00.000Z"),
        entrante("c1", "2026-10-05T10:00:00.000Z"),
      ],
    });
    expect(r.responses).toBe(1);
    expect(r.medianMinutes).toBe(0);
    expect(r.unanswered).toBe(0);
  });

  it("sin mensajes no inventa ceros", () => {
    const r = computeResponseTimes({ scope: "all", ...PERIODO, messages: [] });
    expect(r.responses).toBe(0);
    expect(r.medianMinutes).toBeNull();
    expect(r.averageMinutes).toBeNull();
    expect(r.byAdvisor).toEqual([]);
  });
});

describe("formato", () => {
  it("usa la unidad que se lee de un vistazo", () => {
    expect(formatMinutes(null)).toBe("—");
    expect(formatMinutes(0.4)).toBe("menos de 1 min");
    expect(formatMinutes(1)).toBe("1 min");
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(180)).toBe("3 h");
    expect(formatMinutes(60 * 72)).toBe("3 días");
  });
});
