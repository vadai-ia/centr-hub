import { describe, expect, it } from "vitest";
import {
  mapCustomerGraphqlToNormalized,
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

  describe("phone con fallback a default_address.phone (fix bug rehidratación)", () => {
    it("usa customer.phone cuando está presente", () => {
      const result = mapCustomerWebhookToNormalized({
        id: 1,
        phone: "+5215555555555",
        default_address: { phone: "+5215566778899" },
      });
      // Perfil gana sobre dirección cuando ambos están.
      expect(result.phone).toBe("+5215555555555");
    });

    it("cae a default_address.phone cuando customer.phone es null", () => {
      const result = mapCustomerWebhookToNormalized({
        id: 1,
        phone: null,
        default_address: { phone: "+5215566778899" },
      });
      expect(result.phone).toBe("+5215566778899");
    });

    it("cae a default_address.phone cuando customer.phone está ausente", () => {
      const result = mapCustomerWebhookToNormalized({
        id: 1,
        default_address: { phone: "+5215566778899" },
      });
      expect(result.phone).toBe("+5215566778899");
    });

    it("cae a default_address.phone cuando customer.phone es string vacío", () => {
      const result = mapCustomerWebhookToNormalized({
        id: 1,
        phone: "",
        default_address: { phone: "+5215566778899" },
      });
      expect(result.phone).toBe("+5215566778899");
    });

    it("devuelve null cuando perfil y dirección NO tienen phone", () => {
      const result = mapCustomerWebhookToNormalized({
        id: 1,
        phone: null,
        default_address: { city: "CDMX" },
      });
      expect(result.phone).toBe(null);
    });

    it("devuelve null cuando perfil y dirección tienen phone vacío", () => {
      const result = mapCustomerWebhookToNormalized({
        id: 1,
        phone: "  ",
        default_address: { phone: "" },
      });
      expect(result.phone).toBe(null);
    });

    it("devuelve null cuando default_address está ausente y perfil no tiene phone", () => {
      const result = mapCustomerWebhookToNormalized({ id: 1 });
      expect(result.phone).toBe(null);
    });
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

  it("draft abierto: status='open', sin completedAt ni shopifyOrderId (M7.2 B2)", () => {
    const result = mapDraftOrderWebhookToNormalized({
      id: 1,
      customer: { id: 1 },
      line_items: [],
      total_price: "0",
      status: "open",
    });
    expect(result.status).toBe("open");
    expect(result.completedAt).toBe(null);
    expect(result.shopifyOrderId).toBe(null);
  });

  it("draft completado: status='completed' + order_id capturado para shopify_order_id (M7.2 B2)", () => {
    const result = mapDraftOrderWebhookToNormalized({
      id: 999,
      customer: { id: 1 },
      line_items: [],
      total_price: "0",
      status: "completed",
      completed_at: "2026-06-01T12:00:00Z",
      order_id: 7654321,
    });
    expect(result.status).toBe("completed");
    expect(result.completedAt).toBe("2026-06-01T12:00:00Z");
    expect(result.shopifyOrderId).toBe("7654321");
  });

  it("embeddedCustomer hidratado cuando el payload trae customer completo (fix M3)", () => {
    const result = mapDraftOrderWebhookToNormalized({
      id: 999,
      customer: {
        id: 12345,
        first_name: "Ana",
        last_name: "Pérez",
        email: "ana@example.com",
        phone: "+5215555555555",
        tags: "Gina, Anticipo 50%",
        state: "enabled",
        note: "VIP",
        default_address: { city: "CDMX", country: "MX" },
        updated_at: "2026-05-15T08:00:00Z",
        created_at: "2026-05-10T08:00:00Z",
      },
      line_items: [],
      total_price: "0",
    });
    expect(result.shopifyCustomerId).toBe("12345");
    expect(result.embeddedCustomer).not.toBe(null);
    expect(result.embeddedCustomer?.shopifyCustomerId).toBe("12345");
    expect(result.embeddedCustomer?.fullName).toBe("Ana Pérez");
    expect(result.embeddedCustomer?.email).toBe("ana@example.com");
    expect(result.embeddedCustomer?.phone).toBe("+5215555555555");
    expect(result.embeddedCustomer?.tags).toEqual(["Gina", "Anticipo 50%"]);
    expect(result.embeddedCustomer?.state).toBe("enabled");
    expect(result.embeddedCustomer?.note).toBe("VIP");
    expect(result.embeddedCustomer?.address).toMatchObject({ city: "CDMX" });
    expect(result.embeddedCustomer?.updatedAt).toBe("2026-05-15T08:00:00Z");
    expect(result.embeddedCustomer?.createdAt).toBe("2026-05-10T08:00:00Z");
  });

  it("embeddedCustomer = null cuando el payload no trae customer", () => {
    const result = mapDraftOrderWebhookToNormalized({
      id: 1,
      line_items: [],
      total_price: "0",
    });
    expect(result.shopifyCustomerId).toBe(null);
    expect(result.embeddedCustomer).toBe(null);
  });

  it("embeddedCustomer = null cuando customer existe pero sin id", () => {
    const result = mapDraftOrderWebhookToNormalized({
      id: 1,
      customer: { first_name: "Sin Id" },
      line_items: [],
      total_price: "0",
    });
    expect(result.shopifyCustomerId).toBe(null);
    expect(result.embeddedCustomer).toBe(null);
  });

  it("embeddedCustomer mínimo cuando solo viene customer.id (fallback)", () => {
    const result = mapDraftOrderWebhookToNormalized({
      id: 1,
      customer: { id: 12345 },
      line_items: [],
      total_price: "0",
    });
    expect(result.shopifyCustomerId).toBe("12345");
    expect(result.embeddedCustomer).not.toBe(null);
    expect(result.embeddedCustomer?.fullName).toBe(null);
    expect(result.embeddedCustomer?.email).toBe(null);
    expect(result.embeddedCustomer?.phone).toBe(null);
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

  it("embeddedCustomer hidratado cuando el payload trae customer completo (fix M3)", () => {
    const result = mapOrderWebhookToNormalized({
      id: 5555,
      customer: {
        id: 99,
        first_name: "Bruno",
        last_name: "Díaz",
        email: "bruno@example.com",
        phone: "+5215566778899",
        default_address: { city: "GDL" },
        updated_at: "2026-05-10T12:00:00Z",
      },
      line_items: [],
      total_price: "0",
    });
    expect(result.shopifyCustomerId).toBe("99");
    expect(result.embeddedCustomer).not.toBe(null);
    expect(result.embeddedCustomer?.fullName).toBe("Bruno Díaz");
    expect(result.embeddedCustomer?.email).toBe("bruno@example.com");
    expect(result.embeddedCustomer?.phone).toBe("+5215566778899");
    expect(result.embeddedCustomer?.address).toMatchObject({ city: "GDL" });
    expect(result.embeddedCustomer?.updatedAt).toBe("2026-05-10T12:00:00Z");
  });

  it("embeddedCustomer = null si el order es guest checkout (sin customer)", () => {
    const result = mapOrderWebhookToNormalized({
      id: 1,
      line_items: [],
      total_price: "0",
    });
    expect(result.shopifyCustomerId).toBe(null);
    expect(result.embeddedCustomer).toBe(null);
  });

  it("embeddedCustomer parcial cuando solo viene first_name (sin email/phone)", () => {
    const result = mapOrderWebhookToNormalized({
      id: 1,
      customer: { id: 42, first_name: "Solo Nombre" },
      line_items: [],
      total_price: "0",
    });
    expect(result.shopifyCustomerId).toBe("42");
    expect(result.embeddedCustomer?.fullName).toBe("Solo Nombre");
    expect(result.embeddedCustomer?.email).toBe(null);
    expect(result.embeddedCustomer?.phone).toBe(null);
  });

  it("embeddedCustomer toma phone de default_address cuando perfil no lo trae (fix rehidratación)", () => {
    const result = mapOrderWebhookToNormalized({
      id: 1,
      customer: {
        id: 42,
        first_name: "Lola",
        email: "lola@example.com",
        phone: null,
        default_address: { phone: "+5215511223344", city: "CDMX" },
      },
      line_items: [],
      total_price: "0",
    });
    expect(result.embeddedCustomer?.phone).toBe("+5215511223344");
  });
});

describe("mapCustomerGraphqlToNormalized — phone fallback a defaultAddress.phone", () => {
  it("usa node.phone cuando está presente", () => {
    const result = mapCustomerGraphqlToNormalized({
      id: "gid://shopify/Customer/1",
      firstName: "Ana",
      phone: "+5215555555555",
      defaultAddress: { phone: "+5215566778899" },
    });
    expect(result.phone).toBe("+5215555555555");
  });

  it("cae a defaultAddress.phone cuando node.phone es null", () => {
    const result = mapCustomerGraphqlToNormalized({
      id: "gid://shopify/Customer/1",
      firstName: "Ana",
      phone: null,
      defaultAddress: { phone: "+5215566778899" },
    });
    expect(result.phone).toBe("+5215566778899");
  });

  it("devuelve null sin phone ni defaultAddress.phone", () => {
    const result = mapCustomerGraphqlToNormalized({
      id: "gid://shopify/Customer/1",
      firstName: "Ana",
    });
    expect(result.phone).toBe(null);
  });
});
