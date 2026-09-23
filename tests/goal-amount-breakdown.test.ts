import { describe, expect, it } from "vitest";
import {
  paidOrderInGoalScope,
  tallyAchievement,
  type GoalScope,
} from "@/lib/services/dashboard-metrics";
import { summarizeAmountBreakdown } from "@/lib/services/goal-amount-breakdown";
import type { PaidOrderDetailRow } from "@/lib/db/goal-breakdown";

/**
 * "Ver pedidos" debe sumar EXACTAMENTE lo que marca la barra de la meta de
 * monto. Si el filtro del desglose y el tally divergen, el admin ve una tabla
 * que no cuadra con su propia meta.
 */
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

/** Septiembre 2026 en MX — el mes que mira el desglose. */
const PERIOD = { startUtc: "2026-09-01T06:00:00.000Z", endUtc: "2026-10-01T05:59:59.999Z" };

function order(over: Partial<PaidOrderDetailRow>): PaidOrderDetailRow {
  return {
    id: over.shopify_name ?? "ord-1",
    shopify_name: "#1",
    paid_at: "2026-09-05T18:00:00.000Z",
    settled_at: "2026-09-05T18:00:00.000Z",
    financial_status: "paid",
    cancelled_at: null,
    shopify_tags: [],
    subtotal: "100",
    discount_amount: "0",
    shipping_amount: "0",
    total_amount: "100",
    currency: "MXN",
    assigned_advisor_id: null,
    is_outbound: false,
    source: "shopify_draft_order",
    contact: { full_name: "Cliente", email: null, phone: null },
    ...over,
  };
}

const orders = [
  order({ shopify_name: "#1", assigned_advisor_id: A, subtotal: "900", discount_amount: "100", shipping_amount: "50", total_amount: "950" }),
  order({ shopify_name: "#2", assigned_advisor_id: A, subtotal: "300" }),
  order({ shopify_name: "#3", assigned_advisor_id: B, subtotal: "200" }),
  // Cotización sin etiqueta de vendedor: NO es orgánica.
  order({ shopify_name: "#4", subtotal: "70" }),
  // Tienda online.
  order({ shopify_name: "#5", source: "web", subtotal: "40" }),
];

const sumFor = (scope: GoalScope) =>
  summarizeAmountBreakdown(orders.filter((o) => paidOrderInGoalScope(o, scope)), PERIOD).totals
    .subtotal;

describe("desglose de la meta de monto", () => {
  it("equipo y asesor suman lo mismo que el tally de la barra", () => {
    expect(sumFor({ kind: "team" })).toBe(tallyAchievement(orders, [], [], "all").amount);
    expect(sumFor({ kind: "advisor", membershipId: A })).toBe(tallyAchievement(orders, [], [], A).amount);
    expect(sumFor({ kind: "advisor", membershipId: B })).toBe(200);
  });

  it("orgánica es la tienda online, no la venta sin asesor", () => {
    expect(sumFor({ kind: "organic" })).toBe(40);
  });

  it("productos = subtotal + descuento; el envío se muestra pero no suma", () => {
    const b = summarizeAmountBreakdown([orders[0]], PERIOD);
    expect(b.rows[0]).toMatchObject({ products: 1000, discount: 100, subtotal: 900, shipping: 50, total: 950 });
    expect(b.totals.subtotal).toBe(900);
  });

  it("un pedido con anticipo muestra SOLO la porción del mes, y lo dice", () => {
    // Anticipo en septiembre, liquidación en octubre: el desglose de
    // septiembre enseña la mitad y la etiqueta explica por qué.
    const partido = order({
      shopify_name: "#6",
      subtotal: "1000",
      total_amount: "1000",
      settled_at: "2026-10-10T18:00:00.000Z",
      shopify_tags: ["Anticipo50%"],
    });
    const b = summarizeAmountBreakdown([partido], PERIOD);
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0].subtotal).toBe(500);
    expect(b.rows[0].note).toBe("anticipo 50%");
    expect(b.totals.subtotal).toBe(500);
  });

  it("un pedido cancelado no aparece en el desglose", () => {
    const cancelado = order({ shopify_name: "#7", subtotal: "500", cancelled_at: "2026-09-20T00:00:00.000Z" });
    expect(summarizeAmountBreakdown([cancelado], PERIOD).rows).toEqual([]);
  });
});
