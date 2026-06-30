import { describe, expect, it } from "vitest";
import {
  evaluatePostventaTarget,
  type OrderStatusSnapshot,
} from "@/lib/services/postventa-engine";

function order(partial: Partial<OrderStatusSnapshot>): OrderStatusSnapshot {
  return {
    financial_status: "pending",
    fulfillment_status: null,
    delivery_status: null,
    cancelled_at: null,
    ...partial,
  };
}

describe("evaluatePostventaTarget — mapeo confirmado por Centr (cambio 0036)", () => {
  it("pago pendiente, sin entrega → Cotización completada (pos 1)", () => {
    const t = evaluatePostventaTarget(order({ financial_status: "pending" }));
    expect(t).toMatchObject({ kind: "advance", position: 1 });
  });

  it("pago pagado, sin entrega → Pago confirmado (pos 2)", () => {
    const t = evaluatePostventaTarget(order({ financial_status: "paid" }));
    expect(t).toMatchObject({ kind: "advance", position: 2 });
  });

  it("entrega en curso ('Seguimiento añadido') → Envío en curso (pos 3)", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "paid", delivery_status: "in_progress" }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 3 });
  });

  it("entrega entregada → Entregado (pos 4)", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "paid", delivery_status: "delivered" }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 4 });
  });
});

describe("precedencia entrega > pago (cambio 0036)", () => {
  it("entregado gana aunque el pago siga pendiente (caso raro)", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "pending", delivery_status: "delivered" }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 4 });
  });

  it("en curso gana sobre pago pagado → Envío en curso, no Pago confirmado", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "paid", delivery_status: "in_progress" }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 3 });
  });

  it("sin señal de entrega (null) → cae a pago", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "paid", delivery_status: null }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 2 });
  });
});

describe("fulfillment_status YA NO participa (cambio 0036)", () => {
  it("fulfilled SIN entrega → NO va a Entregado; cae a pago", () => {
    const t = evaluatePostventaTarget(
      order({
        financial_status: "paid",
        fulfillment_status: "fulfilled",
        delivery_status: null,
      }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 2 });
  });

  it("partial SIN entrega → NO va a Envío en curso; cae a pago", () => {
    const t = evaluatePostventaTarget(
      order({
        financial_status: "paid",
        fulfillment_status: "partial",
        delivery_status: null,
      }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 2 });
  });
});

describe("pago parcial (partially_paid = pendiente)", () => {
  it("partially_paid sin entrega → Cotización completada (pos 1)", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "partially_paid" }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 1 });
  });

  it("partially_paid pero ya entregado → Entregado (entrega precede)", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "partially_paid", delivery_status: "delivered" }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 4 });
  });
});

describe("cancelado / reembolsado → Caso problemático (one-way)", () => {
  it("cancelled_at set → problem (aunque esté pagado y entregado)", () => {
    const t = evaluatePostventaTarget(
      order({
        financial_status: "paid",
        delivery_status: "delivered",
        cancelled_at: "2026-06-19T10:00:00Z",
      }),
    );
    expect(t.kind).toBe("problem");
  });

  it("financial refunded → problem", () => {
    const t = evaluatePostventaTarget(order({ financial_status: "refunded" }));
    expect(t.kind).toBe("problem");
  });

  it("financial partially_refunded → problem (precede a entrega)", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "partially_refunded", delivery_status: "delivered" }),
    );
    expect(t.kind).toBe("problem");
  });
});

describe("estados inesperados / robustez", () => {
  it("financial_status desconocido sin entrega → none (no mover)", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "authorized", delivery_status: null }),
    );
    expect(t.kind).toBe("none");
  });

  it("es case-insensitive y tolera espacios", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "  PAID  ", delivery_status: " DELIVERED " }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 4 });
  });

  it("financial_status desconocido pero entregado → entrega precede igual", () => {
    const t = evaluatePostventaTarget(
      order({ financial_status: "authorized", delivery_status: "delivered" }),
    );
    expect(t).toMatchObject({ kind: "advance", position: 4 });
  });
});
