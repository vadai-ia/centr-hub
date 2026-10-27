import { describe, expect, it } from "vitest";
import {
  computeTaggedRevenue,
  readHighlightTags,
  type TaggedRevenueEntry,
} from "@/lib/services/tagged-revenue";

/**
 * Venta por etiqueta de Shopify (Evento, …).
 *
 * Pedido de la dirección: "cuánto se está vendiendo por mes con la etiqueta
 * (Evento) — que sea el total". Es un DESGLOSE transversal: esa venta ya está
 * contada en el KPI y en la meta de quien la hizo.
 */

const monthKeyOf = (iso: string) => iso.slice(0, 7);
const MESES = ["2026-09", "2026-10"];

function entry(over: Partial<TaggedRevenueEntry> = {}): TaggedRevenueEntry {
  return { tags: ["Evento"], subtotal: "1000", paid_at: "2026-10-05T18:00:00.000Z", ...over };
}

describe("readHighlightTags", () => {
  it("lee las etiquetas configuradas por la organización", () => {
    expect(readHighlightTags({ dashboard: { highlight_tags: ["Evento", "Embajador"] } })).toEqual([
      "Evento",
      "Embajador",
    ]);
  });

  it("sin configuración no hay tarjeta", () => {
    // Una tarjeta en ceros para una etiqueta que nadie usa es ruido.
    expect(readHighlightTags(null)).toEqual([]);
    expect(readHighlightTags({})).toEqual([]);
    expect(readHighlightTags({ dashboard: {} })).toEqual([]);
  });

  it("un config mal escrito NO tumba el dashboard", () => {
    expect(readHighlightTags({ dashboard: { highlight_tags: "Evento" } })).toEqual([]);
    expect(readHighlightTags({ dashboard: { highlight_tags: [1, null, "Evento", "  "] } })).toEqual([
      "Evento",
    ]);
  });

  it("no repite la misma etiqueta ni deja crecer la lista sin límite", () => {
    expect(readHighlightTags({ dashboard: { highlight_tags: ["Evento", "evento"] } })).toEqual([
      "Evento",
    ]);
    const muchas = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(readHighlightTags({ dashboard: { highlight_tags: muchas } })).toHaveLength(6);
  });
});

describe("computeTaggedRevenue", () => {
  it("suma el total y lo reparte por mes", () => {
    const [evento] = computeTaggedRevenue({
      entries: [
        entry({ subtotal: "4165", paid_at: "2026-10-05T18:00:00.000Z" }),
        entry({ subtotal: "2000", paid_at: "2026-09-20T18:00:00.000Z" }),
      ],
      tags: ["Evento"],
      monthKeys: MESES,
      monthKeyOf,
    });
    expect(evento.total).toBe(6165);
    expect(evento.count).toBe(2);
    expect(evento.byMonth).toEqual([
      { monthKey: "2026-09", value: 2000 },
      { monthKey: "2026-10", value: 4165 },
    ]);
  });

  it("ignora los pedidos que no llevan la etiqueta", () => {
    const [evento] = computeTaggedRevenue({
      entries: [entry(), entry({ tags: ["Factura", "Gina Jiménez"], subtotal: "99999" })],
      tags: ["Evento"],
      monthKeys: MESES,
      monthKeyOf,
    });
    expect(evento.total).toBe(1000);
  });

  it("la etiqueta empata sin importar mayúsculas ni espacios", () => {
    // Shopify deja escribirla como sea; el CRM ya trata las variantes igual.
    const [evento] = computeTaggedRevenue({
      entries: [entry({ tags: [" EVENTO "] }), entry({ tags: ["evento"] })],
      tags: ["Evento"],
      monthKeys: MESES,
      monthKeyOf,
    });
    expect(evento.count).toBe(2);
  });

  it("una etiqueta sin ventas sale en CERO, no desaparece", () => {
    // Un cero dice "este mes no se vendió"; una fila que falta se lee como
    // que la tarjeta está rota.
    const [embajador] = computeTaggedRevenue({
      entries: [entry()],
      tags: ["Embajador"],
      monthKeys: MESES,
      monthKeyOf,
    });
    expect(embajador).toMatchObject({ tag: "Embajador", total: 0, count: 0 });
    expect(embajador.byMonth.every((m) => m.value === 0)).toBe(true);
  });

  it("sin etiquetas configuradas no devuelve nada", () => {
    expect(computeTaggedRevenue({ entries: [entry()], tags: [], monthKeys: MESES, monthKeyOf })).toEqual([]);
  });

  it("cada mitad de un anticipo cae en su propio mes", () => {
    // Las porciones ya vienen partidas por revenue-recognition; aquí solo se
    // comprueba que la etiqueta viaja con las dos.
    const [evento] = computeTaggedRevenue({
      entries: [
        entry({ subtotal: "500", paid_at: "2026-09-10T18:00:00.000Z" }),
        entry({ subtotal: "500", paid_at: "2026-10-10T18:00:00.000Z" }),
      ],
      tags: ["Evento"],
      monthKeys: MESES,
      monthKeyOf,
    });
    expect(evento.total).toBe(1000);
    expect(evento.byMonth).toEqual([
      { monthKey: "2026-09", value: 500 },
      { monthKey: "2026-10", value: 500 },
    ]);
  });

  it("dice QUIÉN la vendió, de mayor a menor", () => {
    // Lo pidió la dirección: identificar la venta de la etiqueta vendedor
    // por vendedor, no solo el total.
    const [evento] = computeTaggedRevenue({
      entries: [
        entry({ subtotal: "1000", assigned_advisor_id: "gina" }),
        entry({ subtotal: "500", assigned_advisor_id: "pepe" }),
        entry({ subtotal: "2000", assigned_advisor_id: "gina" }),
        entry({ subtotal: "300", assigned_advisor_id: null }),
      ],
      tags: ["Evento"],
      monthKeys: MESES,
      monthKeyOf,
    });
    expect(evento.byAdvisor).toEqual([
      { membershipId: "gina", amount: 3000 },
      { membershipId: "pepe", amount: 500 },
      { membershipId: null, amount: 300 },
    ]);
  });

  it("quien no vendió con la etiqueta no aparece en el desglose", () => {
    // Una lista con todos los vendedores en cero no dice nada y alarga la
    // tarjeta: el que no sale es porque no vendió.
    const [evento] = computeTaggedRevenue({
      entries: [
        entry({ subtotal: "1000", assigned_advisor_id: "gina" }),
        entry({ tags: ["Factura"], subtotal: "9999", assigned_advisor_id: "pepe" }),
      ],
      tags: ["Evento"],
      monthKeys: MESES,
      monthKeyOf,
    });
    expect(evento.byAdvisor).toEqual([{ membershipId: "gina", amount: 1000 }]);
  });

  it("el desglose por vendedor suma el total", () => {
    const [evento] = computeTaggedRevenue({
      entries: [
        entry({ subtotal: "1000", assigned_advisor_id: "gina" }),
        entry({ subtotal: "500", assigned_advisor_id: "pepe" }),
      ],
      tags: ["Evento"],
      monthKeys: MESES,
      monthKeyOf,
    });
    expect(evento.byAdvisor.reduce((s, a) => s + a.amount, 0)).toBe(evento.total);
  });

  it("una porción fuera de los meses del periodo suma al total pero no rompe la serie", () => {
    const [evento] = computeTaggedRevenue({
      entries: [entry({ subtotal: "700", paid_at: "2026-01-04T18:00:00.000Z" })],
      tags: ["Evento"],
      monthKeys: MESES,
      monthKeyOf,
    });
    expect(evento.total).toBe(700);
    expect(evento.byMonth.every((m) => m.value === 0)).toBe(true);
  });
});
