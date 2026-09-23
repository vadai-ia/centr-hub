import { describe, expect, it } from "vitest";
import {
  advancePercentFromTags,
  recognitionSlices,
  recognitionSlicesInPeriod,
  type RecognizableOrder,
} from "@/lib/services/revenue-recognition";

/**
 * Reconocimiento de ingresos por anticipo.
 *
 * Regla de la dirección (confirmada): si el pedido lleva la etiqueta de
 * anticipo, ESA MITAD se registra en el mes en que entró y el resto en el mes
 * en que el pedido se finaliza. Cada mitad en su propio mes.
 */

const JULIO = "2026-07-09T03:06:34.000Z";
const SEPTIEMBRE = "2026-09-08T19:30:30.000Z";

function order(p: Partial<RecognizableOrder> = {}): RecognizableOrder {
  return {
    subtotal: "1000",
    paid_at: JULIO,
    settled_at: null,
    financial_status: "paid",
    cancelled_at: null,
    shopify_tags: [],
    ...p,
  };
}

describe("advancePercentFromTags", () => {
  it("lee el porcentaje del nombre de la etiqueta", () => {
    expect(advancePercentFromTags(["Anticipo50%"])).toBe(50);
    expect(advancePercentFromTags(["Anticipo60%"])).toBe(60);
    // Agregar un porcentaje nuevo no debe requerir deploy ni configuración.
    expect(advancePercentFromTags(["Anticipo40%"])).toBe(40);
  });

  it("tolera mayúsculas y espacios", () => {
    expect(advancePercentFromTags(["ANTICIPO 50 %"])).toBe(50);
    expect(advancePercentFromTags([" anticipo50% "])).toBe(50);
  });

  it("ignora etiquetas que no son de anticipo", () => {
    expect(advancePercentFromTags(["Factura", "GinaJiménez", "C2", "PPD"])).toBeNull();
    expect(advancePercentFromTags([])).toBeNull();
    expect(advancePercentFromTags(null)).toBeNull();
  });

  it("0% y 100% no parten nada; fuera de rango es etiqueta mal escrita", () => {
    expect(advancePercentFromTags(["Anticipo0%"])).toBeNull();
    expect(advancePercentFromTags(["Anticipo100%"])).toBeNull();
    expect(advancePercentFromTags(["Anticipo150%"])).toBeNull();
  });
});

describe("recognitionSlices — sin etiqueta de anticipo (comportamiento de siempre)", () => {
  it("un pedido pagado cuenta completo en su mes", () => {
    expect(recognitionSlices(order())).toEqual([{ amount: 1000, at: JULIO }]);
  });

  it("un pedido pendiente no cuenta nada", () => {
    expect(recognitionSlices(order({ financial_status: "pending" }))).toEqual([]);
  });
});

describe("recognitionSlices — con etiqueta de anticipo", () => {
  it("pendiente de pago: cuenta SOLO el anticipo, en el mes del pedido", () => {
    // Es el caso que la dirección pidió que dejara de marcar cero.
    const slices = recognitionSlices(
      order({ financial_status: "pending", shopify_tags: ["Anticipo50%", "Factura"] }),
    );
    expect(slices).toEqual([{ amount: 500, at: JULIO }]);
  });

  it("liquidado en otro mes: cada mitad cae en SU mes", () => {
    const slices = recognitionSlices(
      order({ settled_at: SEPTIEMBRE, shopify_tags: ["Anticipo50%"] }),
    );
    expect(slices).toEqual([
      { amount: 500, at: JULIO },
      { amount: 500, at: SEPTIEMBRE },
    ]);
  });

  it("respeta el porcentaje de la etiqueta (60/40)", () => {
    const slices = recognitionSlices(
      order({ settled_at: SEPTIEMBRE, shopify_tags: ["Anticipo60%"] }),
    );
    expect(slices).toEqual([
      { amount: 600, at: JULIO },
      { amount: 400, at: SEPTIEMBRE },
    ]);
  });

  it("anticipo y liquidación en el mismo mes suman el pedido completo", () => {
    const slices = recognitionSlices(order({ settled_at: JULIO, shopify_tags: ["Anticipo50%"] }));
    expect(slices.reduce((s, x) => s + x.amount, 0)).toBe(1000);
  });

  it("sin liquidar todavía: la segunda mitad no se adelanta", () => {
    const slices = recognitionSlices(
      order({ financial_status: "partially_paid", shopify_tags: ["Anticipo50%"] }),
    );
    expect(slices).toHaveLength(1);
    expect(slices[0].amount).toBe(500);
  });
});

describe("recognitionSlices — lo que NO es venta", () => {
  it("un pedido cancelado no aporta nada, aunque siga 'paid'", () => {
    // Shopify deja financial_status='paid' al cancelar sin reembolso.
    expect(
      recognitionSlices(order({ cancelled_at: SEPTIEMBRE, shopify_tags: ["Anticipo50%"] })),
    ).toEqual([]);
  });

  it("reembolsado o anulado no aporta nada", () => {
    expect(recognitionSlices(order({ financial_status: "refunded" }))).toEqual([]);
    expect(recognitionSlices(order({ financial_status: "voided" }))).toEqual([]);
  });

  it("sin fecha del pedido no hay mes al cual cargarlo", () => {
    expect(recognitionSlices(order({ paid_at: null }))).toEqual([]);
  });
});

describe("recognitionSlicesInPeriod", () => {
  const JULIO_INICIO = "2026-07-01T06:00:00.000Z";
  const JULIO_FIN = "2026-08-01T05:59:59.999Z";
  const SEPT_INICIO = "2026-09-01T06:00:00.000Z";
  const SEPT_FIN = "2026-10-01T05:59:59.999Z";

  const partido = order({ settled_at: SEPTIEMBRE, shopify_tags: ["Anticipo50%"] });

  it("julio ve solo el anticipo", () => {
    expect(recognitionSlicesInPeriod(partido, JULIO_INICIO, JULIO_FIN)).toEqual([
      { amount: 500, at: JULIO },
    ]);
  });

  it("septiembre ve solo la liquidación", () => {
    expect(recognitionSlicesInPeriod(partido, SEPT_INICIO, SEPT_FIN)).toEqual([
      { amount: 500, at: SEPTIEMBRE },
    ]);
  });

  it("agosto no ve nada de ese pedido", () => {
    expect(
      recognitionSlicesInPeriod(partido, "2026-08-01T06:00:00.000Z", "2026-09-01T05:59:59.999Z"),
    ).toEqual([]);
  });
});
