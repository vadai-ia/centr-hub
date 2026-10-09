import { describe, expect, it } from "vitest";
import {
  computeLeadTimings,
  formatElapsed,
  type TimingCohortMember,
  type TimingHistoryEntry,
} from "@/lib/services/lead-timings";
import type { EntryChannel } from "@/lib/services/contact-journey";

/**
 * Tiempos y origen de la cohorte de leads (punto 24). Módulo puro.
 *
 * La etapa inicial está en la posición 1; cualquier posición mayor es avance.
 */

const MX = "America/Mexico_City";

function miembro(
  contactId: string,
  entryAt: string,
  isOutbound = false,
): TimingCohortMember {
  return { contactId, entryAt, isOutbound };
}

function h(
  contactId: string,
  position: number,
  occurredAt: string,
): TimingHistoryEntry {
  return { contactId, position, occurredAt };
}

function run(
  cohort: TimingCohortMember[],
  history: TimingHistoryEntry[],
  channelByContact: Map<string, EntryChannel> = new Map(),
) {
  return computeLeadTimings({
    cohort,
    history,
    initialPosition: 1,
    channelByContact,
    zone: MX,
  });
}

describe("primer avance", () => {
  it("mide del momento de entrada al primer movimiento posterior", () => {
    const t = run(
      [miembro("c1", "2026-10-01T15:00:00.000Z")],
      [
        h("c1", 1, "2026-10-01T15:00:00.000Z"),
        h("c1", 2, "2026-10-01T18:00:00.000Z"),
      ],
    );
    expect(t.medianHoursToFirstMove).toBe(3);
    expect(t.movedCount).toBe(1);
    expect(t.withoutMove).toBe(0);
  });

  it("el movimiento de nacimiento NO cuenta como avance", () => {
    // La tarjeta aterriza en su etapa inicial en el mismo instante en que el
    // lead entra. Contarlo daría 0 h para todo el mundo.
    const t = run(
      [miembro("c1", "2026-10-01T15:00:00.000Z")],
      [h("c1", 1, "2026-10-01T15:00:00.000Z")],
    );
    expect(t.medianHoursToFirstMove).toBeNull();
    expect(t.withoutMove).toBe(1);
  });

  it("un movimiento a una etapa igual o anterior a la inicial tampoco cuenta", () => {
    const t = run(
      [miembro("c1", "2026-10-01T15:00:00.000Z")],
      [h("c1", 1, "2026-10-02T15:00:00.000Z")],
    );
    expect(t.withoutMove).toBe(1);
  });

  it("toma el PRIMER avance, no el último", () => {
    const t = run(
      [miembro("c1", "2026-10-01T15:00:00.000Z")],
      [
        h("c1", 6, "2026-10-05T15:00:00.000Z"),
        h("c1", 2, "2026-10-01T17:00:00.000Z"),
      ],
    );
    expect(t.medianHoursToFirstMove).toBe(2);
  });

  it("la mediana no la arrastra el lead olvidado; el promedio sí", () => {
    // Es la razón de mostrar las dos: con un solo lento, el promedio hace
    // parecer lento a todo el equipo. Medido en Centr: mediana 41 h,
    // promedio 5 días.
    const cohort = ["c1", "c2", "c3"].map((c) =>
      miembro(c, "2026-10-01T00:00:00.000Z"),
    );
    const t = run(cohort, [
      h("c1", 2, "2026-10-01T01:00:00.000Z"), // 1 h
      h("c2", 2, "2026-10-01T03:00:00.000Z"), // 3 h
      h("c3", 2, "2026-10-21T00:00:00.000Z"), // 480 h
    ]);
    expect(t.medianHoursToFirstMove).toBe(3);
    expect(t.averageHoursToFirstMove).toBeCloseTo((1 + 3 + 480) / 3, 5);
  });

  it("un avance fechado ANTES de la entrada no produce horas negativas", () => {
    // Pasa con las re-fechas de Shopify (migración 0025): el avance se
    // trata como inmediato, no como un tiempo negativo que rompa la media.
    const t = run(
      [miembro("c1", "2026-10-05T15:00:00.000Z")],
      [
        h("c1", 2, "2026-10-05T16:00:00.000Z"),
        h("c1", 3, "2026-10-01T15:00:00.000Z"),
      ],
    );
    expect(t.medianHoursToFirstMove).toBe(1);
    expect(t.medianHoursToFirstMove!).toBeGreaterThanOrEqual(0);
  });

  it("quien entró dos veces en el periodo cuenta una vez, con su entrada MÁS VIEJA", () => {
    const t = run(
      [
        miembro("c1", "2026-10-05T15:00:00.000Z"),
        miembro("c1", "2026-10-01T15:00:00.000Z"),
      ],
      [h("c1", 2, "2026-10-01T18:00:00.000Z")],
    );
    expect(t.cohortSize).toBe(1);
    expect(t.medianHoursToFirstMove).toBe(3);
  });

  it("el historial de alguien FUERA de la cohorte se ignora", () => {
    const t = run(
      [miembro("c1", "2026-10-01T15:00:00.000Z")],
      [h("c2", 6, "2026-10-01T16:00:00.000Z")],
    );
    expect(t.withoutMove).toBe(1);
    expect(t.cohortSize).toBe(1);
  });

  it("sin cohorte no hay división por cero", () => {
    const t = run([], [h("c1", 6, "2026-10-01T16:00:00.000Z")]);
    expect(t.cohortSize).toBe(0);
    expect(t.medianHoursToFirstMove).toBeNull();
    expect(t.averageHoursToFirstMove).toBeNull();
    expect(t.byChannel).toEqual([]);
  });
});

describe("reparto por canal", () => {
  it("el outbound declarado gana sobre la bitácora", () => {
    // `is_outbound` es la marca declarada (0040): es un hecho, no una pista.
    const t = run(
      [miembro("c1", "2026-10-01T15:00:00.000Z", true)],
      [],
      new Map<string, EntryChannel>([["c1", "formulario"]]),
    );
    expect(t.byChannel).toEqual([
      { channel: "outbound", count: 1, share: 1 },
    ]);
  });

  it("sin canal en la bitácora queda 'desconocido', no un canal inventado", () => {
    const t = run([miembro("c1", "2026-10-01T15:00:00.000Z")], []);
    expect(t.byChannel[0]?.channel).toBe("desconocido");
  });

  it("ordena del canal más frecuente al menos, con su fracción", () => {
    const t = run(
      [
        miembro("c1", "2026-10-01T00:00:00.000Z"),
        miembro("c2", "2026-10-01T00:00:00.000Z"),
        miembro("c3", "2026-10-01T00:00:00.000Z"),
        miembro("c4", "2026-10-01T00:00:00.000Z"),
      ],
      [],
      new Map<string, EntryChannel>([
        ["c1", "formulario"],
        ["c2", "formulario"],
        ["c3", "formulario"],
        ["c4", "whatsapp"],
      ]),
    );
    expect(t.byChannel.map((c) => c.channel)).toEqual(["formulario", "whatsapp"]);
    expect(t.byChannel[0]?.share).toBe(0.75);
    expect(t.byChannel[1]?.share).toBe(0.25);
  });

  it("las fracciones suman 1 — nadie se queda fuera del reparto", () => {
    const t = run(
      [
        miembro("c1", "2026-10-01T00:00:00.000Z"),
        miembro("c2", "2026-10-01T00:00:00.000Z", true),
        miembro("c3", "2026-10-01T00:00:00.000Z"),
      ],
      [],
      new Map<string, EntryChannel>([["c1", "whatsapp"]]),
    );
    const suma = t.byChannel.reduce((a, c) => a + (c.share ?? 0), 0);
    expect(suma).toBeCloseTo(1, 10);
    expect(t.byChannel.reduce((a, c) => a + c.count, 0)).toBe(3);
  });
});

describe("formatElapsed", () => {
  it("horas abajo de dos días, días arriba", () => {
    expect(formatElapsed(3)).toBe("3 h");
    expect(formatElapsed(41)).toBe("41 h");
    expect(formatElapsed(120)).toBe("5 días");
  });
  it("el caso corto no dice '0 h'", () => {
    expect(formatElapsed(0.4)).toBe("menos de 1 h");
  });
  it("sin dato dice guion, no NaN", () => {
    expect(formatElapsed(null)).toBe("—");
  });
});
