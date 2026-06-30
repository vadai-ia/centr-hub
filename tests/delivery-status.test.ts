import { describe, expect, it } from "vitest";
import {
  normalizeDeliveryStatus,
  type DeliveryFulfillmentSnapshot,
} from "@/lib/shopify/delivery-status";

const f = (p: Partial<DeliveryFulfillmentSnapshot>): DeliveryFulfillmentSnapshot => ({
  ...p,
});

describe("normalizeDeliveryStatus — sin señal → null", () => {
  it("sin fulfillments → null (la opp se queda en pago)", () => {
    expect(normalizeDeliveryStatus([])).toBeNull();
  });

  it("fulfillment sin tracking ni estado de envío → null", () => {
    expect(normalizeDeliveryStatus([f({})])).toBeNull();
  });

  it("fulfillment cancelado con tracking → null (no cuenta)", () => {
    expect(
      normalizeDeliveryStatus([f({ cancelled: true, hasTracking: true })]),
    ).toBeNull();
  });
});

describe("normalizeDeliveryStatus — entregado", () => {
  it("shipment_status delivered (REST) → delivered", () => {
    expect(normalizeDeliveryStatus([f({ shipmentStatus: "delivered" })])).toBe(
      "delivered",
    );
  });

  it("displayStatus DELIVERED (GraphQL, MAYÚSCULAS) → delivered", () => {
    expect(normalizeDeliveryStatus([f({ displayStatus: "DELIVERED" })])).toBe(
      "delivered",
    );
  });

  it("deliveredAt presente → delivered", () => {
    expect(
      normalizeDeliveryStatus([f({ deliveredAt: "2026-06-20T10:00:00Z" })]),
    ).toBe("delivered");
  });
});

describe("normalizeDeliveryStatus — en curso ('Seguimiento añadido')", () => {
  it("tracking presente pero shipment_status NULL (FedEx aún no escanea) → in_progress", () => {
    // Este es exactamente el caso "Seguimiento añadido" de Centr.
    expect(
      normalizeDeliveryStatus([f({ hasTracking: true, shipmentStatus: null })]),
    ).toBe("in_progress");
  });

  it("shipment_status in_transit → in_progress", () => {
    expect(normalizeDeliveryStatus([f({ shipmentStatus: "in_transit" })])).toBe(
      "in_progress",
    );
  });

  it("displayStatus OUT_FOR_DELIVERY → in_progress", () => {
    expect(
      normalizeDeliveryStatus([f({ displayStatus: "OUT_FOR_DELIVERY" })]),
    ).toBe("in_progress");
  });

  it("shipment_status confirmed → in_progress", () => {
    expect(normalizeDeliveryStatus([f({ shipmentStatus: "confirmed" })])).toBe(
      "in_progress",
    );
  });
});

describe("normalizeDeliveryStatus — multi-fulfillment (envíos parciales)", () => {
  it("todos entregados → delivered", () => {
    expect(
      normalizeDeliveryStatus([
        f({ shipmentStatus: "delivered" }),
        f({ deliveredAt: "2026-06-21T00:00:00Z" }),
      ]),
    ).toBe("delivered");
  });

  it("uno entregado, otro en tránsito → in_progress (parcial cuenta como en curso)", () => {
    expect(
      normalizeDeliveryStatus([
        f({ shipmentStatus: "delivered" }),
        f({ shipmentStatus: "in_transit" }),
      ]),
    ).toBe("in_progress");
  });

  it("entregado + un fulfillment cancelado (ignorado) → delivered", () => {
    expect(
      normalizeDeliveryStatus([
        f({ shipmentStatus: "delivered" }),
        f({ cancelled: true, hasTracking: true }),
      ]),
    ).toBe("delivered");
  });
});
