import { describe, expect, it } from "vitest";
import {
  evaluatePostventaTarget,
  type OrderStatusSnapshot,
} from "@/lib/services/postventa-engine";

function order(partial: Partial<OrderStatusSnapshot>): OrderStatusSnapshot {
  return {
    financial_status: "pending",
    fulfillment_status: null,
    cancelled_at: null,
    ...partial,
  };
}

describe("evaluatePostventaTarget — mapeo confirmado por Centr", () => {
  it("pago pendiente, sin preparación → Cotización completada (pos 1)", () => {
    const t = evaluatePostventaTarget(order({ financial_status: "pending" }));
    expect(t).toMatchObject({ kind: "advance", position: 1 });
  });

  it("pago pagado, sin preparación → Pago confirmado (pos 2)", () => {
    const t = evaluatePostventaTarget(order({ financial_status: "paid" }));
    expect(t).toMatchObject({ kind: "advance", position: 2 });
  });

  it("preparación en curso (partial) → Envío en curso (pos 3)", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "paid", fulfillment_status: "partial" }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 3 });
  });

  it("preparación completa (fulfilled) → Entregado (pos 4)", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "paid", fulfillment_status: "fulfilled" }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 4 });
  });
});

describe("precedencia preparación > pago", () => {
  it("fulfilled gana aunque el pago siga pendiente (caso raro)", () => {
    // Preparación avanza sin pago confirmado: la preparación domina.
    const t = evaluatePostventaTarget(
      order({ financial_status: "pending", fulfillment_status: "fulfilled" }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 4 });
  });

  it("partial gana sobre pago pagado → Envío en curso, no Pago confirmado", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "paid", fulfillment_status: "partial" }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 3 });
  });

  it("unfulfilled NO cuenta como preparación → cae a pago", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "paid", fulfillment_status: "unfulfilled" }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 2 });
  });

  it("fulfillment null → cae a pago", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "pending", fulfillment_status: null }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 1 });
  });
});

describe("pago parcial (decisión M3v2: partially_paid = pendiente)", () => {
  it("partially_paid sin preparación → Cotización completada (pos 1)", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "partially_paid" }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 1 });
  });

  it("partially_paid pero ya fulfilled → Entregado (preparación precede)", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "partially_paid", fulfillment_status: "fulfilled" }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 4 });
  });
});

describe("cancelado / reembolsado → Caso problemático (one-way)", () => {
  it("cancelled_at set → problem (aunque esté pagado y fulfilled)", () => {
    const t = evaluatePostventaTarget(
      order({
        financial_status: "paid",
        fulfillment_status: "fulfilled",
        cancelled_at: "2026-06-19T10:00:00Z",
      }),
    );
    expect(t.kind).toBe("problem");
  });

  it("financial refunded → problem", () => {
    const t = evaluatePostventaTarget(order({ financial_status: "refunded" }));
    expect(t.kind).toBe("problem");
  });

  it("financial partially_refunded → problem", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "partially_refunded", fulfillment_status: "fulfilled" }),
    );
    expect(t.kind).toBe("problem");
  });
});

describe("estados inesperados / robustez", () => {
  it("financial_status desconocido sin preparación → none (no mover)", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "authorized", fulfillment_status: null }),
    );
    expect(t.kind).toBe("none");
  });

  it("es case-insensitive y tolera espacios", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "  PAID  ", fulfillment_status: " FULFILLED " }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 4 });
  });

  it("financial_status desconocido pero fulfilled → preparación precede igual", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "authorized", fulfillment_status: "fulfilled" }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 4 });
  });
});
