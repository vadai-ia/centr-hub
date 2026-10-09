import { describe, expect, it } from "vitest";
import {
  summarizeContactJourney,
  type JourneyContact,
  type JourneyEvent,
} from "@/lib/services/contact-journey";

/**
 * Resumen de entrada del cliente (punto 24). Módulo puro — el "ahora" y la
 * zona entran como parámetros.
 */

const MX = "America/Mexico_City";
const CO = "America/Bogota";
const NOW = "2026-10-09T18:00:00.000Z"; // 12:00 en CDMX

function contact(over: Partial<JourneyContact> = {}): JourneyContact {
  return {
    createdAt: "2026-10-01T16:00:00.000Z",
    isOutbound: false,
    hasWhaapy: true,
    hasShopify: false,
    ...over,
  };
}

function ev(
  occurredAt: string,
  kind: string,
  extra: Partial<JourneyEvent> = {},
): JourneyEvent {
  return { occurredAt, kind, category: "pipeline", ...extra };
}

describe("canal de entrada", () => {
  it("outbound gana sobre cualquier inferencia", () => {
    // `is_outbound` es la marca declarada (0040): es un hecho, no una pista.
    const j = summarizeContactJourney({
      contact: contact({ isOutbound: true, hasShopify: true }),
      events: [ev(NOW, "lead_created", { meta: { source: "webhook" } })],
      nowISO: NOW,
      zone: MX,
    });
    expect(j.entryChannel).toBe("outbound");
  });

  it("la bitácora manda sobre las identidades externas", () => {
    // Un lead de WhatsApp acaba con identidad de Shopify en cuanto alguien
    // le cotiza: inferir del estado actual diría "Shopify" y sería falso.
    const j = summarizeContactJourney({
      contact: contact({ hasShopify: true, hasWhaapy: true }),
      events: [
        ev("2026-10-01T16:00:00.000Z", "lead_created", {
          meta: { event_type: "whaapy_contact_created_from_conversation" },
        }),
      ],
      nowISO: NOW,
      zone: MX,
    });
    expect(j.entryChannel).toBe("whatsapp");
  });

  it("lee la fuente del lead capturado", () => {
    const porFuente = (source: string) =>
      summarizeContactJourney({
        contact: contact(),
        events: [ev("2026-10-01T16:00:00.000Z", "lead_created", { meta: { source } })],
        nowISO: NOW,
        zone: MX,
      }).entryChannel;
    expect(porFuente("webhook")).toBe("formulario");
    expect(porFuente("manual")).toBe("manual");
    expect(porFuente("whaapy")).toBe("whatsapp");
    expect(porFuente("shopify")).toBe("shopify");
  });

  it("toma la entrada MÁS VIEJA, no la última", () => {
    // Alguien que entró por formulario y meses después vuelve por WhatsApp
    // sigue habiendo entrado por formulario.
    const j = summarizeContactJourney({
      contact: contact(),
      events: [
        ev("2026-10-05T16:00:00.000Z", "lead_created", {
          meta: { event_type: "whaapy_contact_created_from_conversation" },
        }),
        ev("2026-10-01T16:00:00.000Z", "lead_created", { meta: { source: "webhook" } }),
      ],
      nowISO: NOW,
      zone: MX,
    });
    expect(j.entryChannel).toBe("formulario");
  });

  it("sin bitácora, infiere de las identidades que tiene", () => {
    expect(
      summarizeContactJourney({
        contact: contact({ hasWhaapy: true, hasShopify: false }),
        events: [],
        nowISO: NOW,
        zone: MX,
      }).entryChannel,
    ).toBe("whatsapp");
    expect(
      summarizeContactJourney({
        contact: contact({ hasWhaapy: false, hasShopify: true }),
        events: [],
        nowISO: NOW,
        zone: MX,
      }).entryChannel,
    ).toBe("shopify");
    // Con las dos identidades y sin bitácora no se puede saber, y decirlo es
    // mejor que inventar un canal.
    expect(
      summarizeContactJourney({
        contact: contact({ hasWhaapy: true, hasShopify: true }),
        events: [],
        nowISO: NOW,
        zone: MX,
      }).entryChannel,
    ).toBe("desconocido");
  });
});

describe("tiempos", () => {
  it("cuenta los días desde que entró", () => {
    const j = summarizeContactJourney({
      contact: contact({ createdAt: "2026-10-01T16:00:00.000Z" }),
      events: [],
      nowISO: NOW,
      zone: MX,
    });
    expect(j.daysSinceEntry).toBe(8);
  });

  it("el primer avance NO cuenta el movimiento de nacimiento", () => {
    // La tarjeta aterriza en su etapa inicial en el mismo instante en que el
    // contacto entra: contarlo como avance daría "0 días" a todo el mundo.
    const entrada = "2026-10-01T16:00:00.000Z";
    const j = summarizeContactJourney({
      contact: contact({ createdAt: entrada }),
      events: [
        ev(entrada, "stage_change"),
        ev("2026-10-04T16:00:00.000Z", "stage_change"),
      ],
      nowISO: NOW,
      zone: MX,
    });
    expect(j.daysToFirstMove).toBe(3);
  });

  it("sin avanzar devuelve null, que es el dato que delata al lead olvidado", () => {
    const entrada = "2026-10-01T16:00:00.000Z";
    const j = summarizeContactJourney({
      contact: contact({ createdAt: entrada }),
      events: [ev(entrada, "stage_change")],
      nowISO: NOW,
      zone: MX,
    });
    expect(j.daysToFirstMove).toBeNull();
  });

  it("el último movimiento es el hecho más reciente de la bitácora", () => {
    const j = summarizeContactJourney({
      contact: contact(),
      events: [
        ev("2026-10-01T16:00:00.000Z", "stage_change"),
        ev("2026-10-07T16:00:00.000Z", "manual_note"),
        ev("2026-10-03T16:00:00.000Z", "task_created"),
      ],
      nowISO: NOW,
      zone: MX,
    });
    expect(j.lastEventAt).toBe("2026-10-07T16:00:00.000Z");
    expect(j.daysSinceLastEvent).toBe(2);
  });

  it("un hecho anterior al alta del contacto corre la entrada hacia atrás", () => {
    // Pasa con los contactos rehidratados desde Shopify: su fila es más
    // nueva que su historia.
    const j = summarizeContactJourney({
      contact: contact({ createdAt: "2026-10-05T16:00:00.000Z" }),
      events: [ev("2026-09-20T16:00:00.000Z", "order_paid")],
      nowISO: NOW,
      zone: MX,
    });
    expect(j.entryAt).toBe("2026-09-20T16:00:00.000Z");
    expect(j.daysSinceEntry).toBe(19);
  });

  it("los días se cuentan en la zona de la ORGANIZACIÓN", () => {
    // 05:30 UTC = 23:30 del 8 en CDMX, pero 00:30 del 9 en Bogotá.
    const entrada = "2026-10-09T05:30:00.000Z";
    const base = { contact: contact({ createdAt: entrada }), events: [], nowISO: NOW };
    expect(summarizeContactJourney({ ...base, zone: MX }).daysSinceEntry).toBe(1);
    expect(summarizeContactJourney({ ...base, zone: CO }).daysSinceEntry).toBe(0);
  });

  it("una fecha inválida no truena: devuelve 0 en lugar de NaN", () => {
    const j = summarizeContactJourney({
      contact: contact({ createdAt: "no-es-fecha" }),
      events: [],
      nowISO: NOW,
      zone: MX,
    });
    expect(j.daysSinceEntry).toBe(0);
  });
});

describe("mensajes y conteo", () => {
  it("cuenta solo los que la plataforma ENVIÓ", () => {
    const j = summarizeContactJourney({
      contact: contact(),
      events: [
        ev("2026-10-02T16:00:00.000Z", "message_sent", { category: "mensajes" }),
        ev("2026-10-03T16:00:00.000Z", "message_sent", { category: "mensajes" }),
        // "no enviado" no es un mensaje enviado.
        ev("2026-10-04T16:00:00.000Z", "message_skipped", { category: "mensajes" }),
        ev("2026-10-05T16:00:00.000Z", "manual_note", { category: "atencion" }),
      ],
      nowISO: NOW,
      zone: MX,
    });
    expect(j.messagesSent).toBe(2);
    expect(j.eventCount).toBe(4);
  });

  it("un contacto sin bitácora no rompe el resumen", () => {
    const j = summarizeContactJourney({
      contact: contact(),
      events: [],
      nowISO: NOW,
      zone: MX,
    });
    expect(j.eventCount).toBe(0);
    expect(j.messagesSent).toBe(0);
    expect(j.lastEventAt).toBeNull();
    expect(j.daysSinceLastEvent).toBeNull();
    expect(j.daysToFirstMove).toBeNull();
  });
});
