import { describe, expect, it } from "vitest";
import { extractShopifyErrorMessage } from "@/lib/shopify/admin-client";

describe("extractShopifyErrorMessage", () => {
  it("aplana errors objeto campo→mensajes a un string legible", () => {
    const msg = extractShopifyErrorMessage({
      errors: {
        phone: ["is invalid"],
        address: ["Country is not a valid country."],
      },
    });
    expect(msg).toContain("phone: is invalid");
    expect(msg).toContain("address: Country is not a valid country.");
  });

  it("errors string se devuelve tal cual", () => {
    expect(extractShopifyErrorMessage({ errors: "Not Found" })).toBe("Not Found");
  });

  it("body string plano se devuelve tal cual", () => {
    expect(extractShopifyErrorMessage("rate limited")).toBe("rate limited");
  });

  it("errors array se une", () => {
    expect(extractShopifyErrorMessage({ errors: ["a", "b"] })).toBe("a; b");
  });

  it("sin errors útil → null (no expone el body completo)", () => {
    expect(extractShopifyErrorMessage({ foo: "bar" })).toBeNull();
    expect(extractShopifyErrorMessage(null)).toBeNull();
    expect(extractShopifyErrorMessage(undefined)).toBeNull();
    expect(extractShopifyErrorMessage({ errors: {} })).toBeNull();
  });

  it("trunca mensajes excesivamente largos", () => {
    const long = "x".repeat(500);
    const msg = extractShopifyErrorMessage({ errors: long });
    expect(msg!.length).toBeLessThanOrEqual(300);
  });
});
