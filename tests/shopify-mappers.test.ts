import { describe, expect, it } from "vitest";
import {
  mapCustomerWebhookToNormalized,
  mapDraftOrderWebhookToNormalized,
  mapOrderWebhookToNormalized,
  shopifyIdToString,
  shopifyTagsCsvToArray,
} from "@/lib/shopify/mappers";

describe("shopifyIdToString", () => {
  it("number → string", () => {
    expect(shopifyIdToString(123)).toBe("123");
  });
  it("string numérica → string", () => {
    expect(shopifyIdToString("456")).toBe("456");
  });
  it("gid → id numérico extraído", () => {
    expect(shopifyIdToString("gid://shopify/Customer/789")).toBe("789");
  });
  it("null/undefined → null", () => {
    expect(shopifyIdToString(null)).toBe(null);
    expect(shopifyIdToString(undefined)).toBe(null);
  });
});

describe("shopifyTagsCsvToArray", () => {
  it("separa y trimea CSV", () => {
    expect(shopifyTagsCsvToArray("a, b , c ")).toEqual(["a", "b", "c"]);
  });
  it("filtra vacíos", () => {
    expect(shopifyTagsCsvToArray("a,,b,  ,c")).toEqual(["a", "b", "c"]);
  });
  it("string vacío o null → []", () => {
    expect(shopifyTagsCsvToArray("")).toEqual([]);
    expect(shopifyTagsCsvToArray(null)).toEqual([]);
    expect(shopifyTagsCsvToArray(undefined)).toEqual([]);
  });
  it("array entrante se preserva trimeado", () => {
    expect(shopifyTagsCsvToArray(["GinaJiménez", "  Factura  "])).toEqual([
      "GinaJiménez",
      "Factura",
    ]);
  });
});

describe("mapCustomerWebhookToNormalized", () => {
  it("aplana first/last name a full_name y normaliza tags CSV", () => {
    const result = mapCustomerWebhookToNormalized({
      id: 12345,
      first_name: "Ana",
      last_name: "Pérez",
      email: "ana@example.com",
      phone: "+5215555555555",
      tags: "GinaJiménez, Factura",
      state: "enabled",
      updated_at: "2026-05-15T10:00:00Z",
    });
    expect(result.shopifyCustomerId).toBe("12345");
    expect(result.fullName).toBe("Ana Pérez");
    expect(result.email).toBe("ana@example.com");
    expect(result.tags).toEqual(["GinaJiménez", "Factura"]);
    expect(result.state).toBe("enabled");
    expect(result.updatedAt).toBe("2026-05-15T10:00:00Z");
  });

  it("acepta tags como array", () => {
    const result = mapCustomerWebhookToNormalized({
      id: "100",
      tags: ["VIP", "Anticipo 50%"],
      first_name: "X",
    });
    expect(result.tags).toEqual(["VIP", "Anticipo 50%"]);
  });

  it("payload mínimo no truena", () => {
    const result = mapCustomerWebhookToNormalized({ id: 1 });
    expect(result.shopifyCustomerId).toBe("1");
    expect(result.fullName).toBe(null);
    expect(result.tags).toEqual([]);
  });
});

describe("mapDraftOrderWebhookToNormalized", () => {
  it("captura customer.id + line_items + totales", () => {
    const result = mapDraftOrderWebhookToNormalized({
      id: 999,
      name: "#D123",
      tags: "Gina",
      customer: { id: 12345 },
      line_items: [
        {
          title: "Producto A",
          quantity: 2,
          price: "100.00",
          original_price: "100.00",
          discounted_price: "90.00",
          product_id: 7777,
          variant_id: 8888,
        },
      ],
      total_price: "180.00",
      subtotal_price: "180.00",
      total_tax: "0",
      currency: "MXN",
      updated_at: "2026-05-01T10:00:00Z",
      created_at: "2026-05-01T09:00:00Z",
    });
    expect(result.shopifyDraftOrderId).toBe("999");
    expect(result.displayReference).toBe("#D123");
    expect(result.tags).toEqual(["Gina"]);
    expect(result.shopifyCustomerId).toBe("12345");
    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0].title).toBe("Producto A");
    expect(result.lineItems[0].quantity).toBe(2);
    expect(result.lineItems[0].originalUnitPrice).toBe("100.00");
    expect(result.lineItems[0].finalPrice).toBe("90.00");
    expect(result.totalAmount).toBe("180.00");
    expect(result.currency).toBe("MXN");
  });

  it("custom line item (product_id null) se preserva con title libre", () => {
    const result = mapDraftOrderWebhookToNormalized({
      id: 1,
      customer: { id: 1 },
      line_items: [
        { title: "Custom item", quantity: 1, price: "50.00", product_id: null },
      ],
      total_price: "50.00",
    });
    expect(result.lineItems[0].shopifyProductId).toBe(null);
    expect(result.lineItems[0].title).toBe("Custom item");
  });
});

describe("mapOrderWebhookToNormalized", () => {
  it("captura financial_status, paid_at, shipping y tags", () => {
    const result = mapOrderWebhookToNormalized({
      id: 5555,
      name: "#1001",
      tags: "Gina, Anticipo 50%, Factura",
      customer: { id: 99 },
      line_items: [
        { title: "X", quantity: 1, price: "200.00" },
      ],
      total_price: "200.00",
      subtotal_price: "200.00",
      total_tax: "0",
      total_shipping_price_set: { shop_money: { amount: "50.00" } },
      total_discounts: "10.00",
      currency: "MXN",
      financial_status: "paid",
      fulfillment_status: "unfulfilled",
      processed_at: "2026-05-10T12:00:00Z",
      updated_at: "2026-05-10T12:00:01Z",
      draft_order_id: 999,
    });
    expect(result.shopifyOrderId).toBe("5555");
    expect(result.shopifyDraftOrderId).toBe("999");
    expect(result.tags).toEqual(["Gina", "Anticipo 50%", "Factura"]);
    expect(result.financialStatus).toBe("paid");
    expect(result.fulfillmentStatus).toBe("unfulfilled");
    expect(result.paidAt).toBe("2026-05-10T12:00:00Z");
    expect(result.shippingAmount).toBe("50.00");
    expect(result.discountAmount).toBe("10.00");
  });
});
