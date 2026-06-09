import { describe, expect, it } from "vitest";
import {
  emptyStructuredAddress,
  formatStructuredAddress,
  isEmptyStructuredAddress,
  parseStoredAddress,
  structuredAddressToJson,
  structuredAddressToShopify,
} from "@/lib/contacts/address";

describe("parseStoredAddress", () => {
  it("lee la forma estructurada nueva (claves canónicas)", () => {
    const addr = parseStoredAddress({
      country: "México",
      first_name: "Ana",
      last_name: "López",
      company: "Acme",
      address1: "Calle 1 #2",
      address2: "Int 3",
      zip: "01000",
      city: "CDMX",
      province: "CDMX",
      phone: "+52 55 1234 5678",
    });
    expect(addr.address1).toBe("Calle 1 #2");
    expect(addr.province).toBe("CDMX");
    expect(addr.first_name).toBe("Ana");
  });

  it("mapea los alias legacy: line1→address1, line2→address2, state→province, postal_code→zip", () => {
    const addr = parseStoredAddress({
      line1: "Av. Siempre Viva 742",
      line2: "Depto 4",
      state: "Jalisco",
      postal_code: "44100",
      city: "Guadalajara",
    });
    expect(addr.address1).toBe("Av. Siempre Viva 742");
    expect(addr.address2).toBe("Depto 4");
    expect(addr.province).toBe("Jalisco");
    expect(addr.zip).toBe("44100");
    expect(addr.city).toBe("Guadalajara");
  });

  it("la forma nueva tiene prioridad sobre el alias legacy", () => {
    const addr = parseStoredAddress({ address1: "Nueva", line1: "Vieja" });
    expect(addr.address1).toBe("Nueva");
  });

  it("null / no-objeto / array → vacía", () => {
    expect(isEmptyStructuredAddress(parseStoredAddress(null))).toBe(true);
    expect(isEmptyStructuredAddress(parseStoredAddress("x" as never))).toBe(true);
    expect(isEmptyStructuredAddress(parseStoredAddress([] as never))).toBe(true);
  });
});

describe("structuredAddressToJson", () => {
  it("persiste solo claves canónicas con contenido (descarta legacy y vacíos)", () => {
    const json = structuredAddressToJson({
      address1: "  Calle 1  ",
      city: "CDMX",
      province: "",
      country: undefined,
    });
    expect(json).toEqual({ address1: "Calle 1", city: "CDMX" });
  });

  it("todo vacío → null (borrado propagado)", () => {
    expect(structuredAddressToJson(emptyStructuredAddress())).toBeNull();
  });

  it("una dirección vieja plana se promueve a estructurada al re-guardar", () => {
    const parsed = parseStoredAddress({ line1: "Calle Vieja 5", city: "Toluca" });
    const json = structuredAddressToJson(parsed) as Record<string, string>;
    expect(json.address1).toBe("Calle Vieja 5");
    expect(json.city).toBe("Toluca");
    expect("line1" in json).toBe(false);
  });
});

describe("structuredAddressToShopify", () => {
  it("normaliza país a country_code y estado a province_code (México con acento no falla)", () => {
    const shop = structuredAddressToShopify({
      address1: "Calle 1",
      city: "Monterrey",
      province: "Nuevo León",
      country: "México",
      zip: "64000",
    });
    expect(shop).toEqual({
      address1: "Calle 1",
      city: "Monterrey",
      province_code: "NLE",
      country_code: "MX",
      zip: "64000",
    });
    expect(shop).not.toHaveProperty("country");
    expect(shop).not.toHaveProperty("province");
  });

  it("resuelve alias de estado (CDMX/DF) a province_code", () => {
    expect(
      structuredAddressToShopify({ country: "Mexico", province: "CDMX" }),
    ).toMatchObject({ country_code: "MX", province_code: "CMX" });
    expect(
      structuredAddressToShopify({ country: "MX", province: "Distrito Federal" }),
    ).toMatchObject({ province_code: "CMX" });
  });

  it("país no reconocido se deja tal cual (Shopify decide)", () => {
    const shop = structuredAddressToShopify({
      address1: "1 Main St",
      country: "Narnia",
      province: "Oeste",
    });
    expect(shop).toMatchObject({ country: "Narnia", province: "Oeste" });
    expect(shop).not.toHaveProperty("country_code");
  });

  it("estado solo se normaliza cuando el país resuelve a MX", () => {
    // País US: province se conserva como nombre (no hay matriz US mapeada).
    const shop = structuredAddressToShopify({
      country: "Estados Unidos",
      province: "Texas",
    });
    expect(shop).toMatchObject({ country_code: "US", province: "Texas" });
    expect(shop).not.toHaveProperty("province_code");
  });

  it("usa fallbackPhone si la dirección no trae teléfono propio", () => {
    const shop = structuredAddressToShopify({ address1: "Calle 1" }, "+5215500000000");
    expect(shop?.phone).toBe("+5215500000000");
  });

  it("respeta el teléfono propio de la dirección sobre el fallback", () => {
    const shop = structuredAddressToShopify(
      { address1: "Calle 1", phone: "+5215511111111" },
      "+5215500000000",
    );
    expect(shop?.phone).toBe("+5215511111111");
  });

  it("dirección vacía → null (no se manda addresses a Shopify)", () => {
    expect(structuredAddressToShopify(emptyStructuredAddress())).toBeNull();
  });
});

describe("formatStructuredAddress", () => {
  it("resume en una línea sin nombre ni teléfono", () => {
    const s = formatStructuredAddress({
      first_name: "Ana",
      phone: "+52...",
      address1: "Calle 1",
      city: "CDMX",
      province: "CDMX",
      zip: "01000",
      country: "México",
    });
    expect(s).toBe("Calle 1, CDMX, CDMX, 01000, México");
  });

  it("vacía → null", () => {
    expect(formatStructuredAddress(emptyStructuredAddress())).toBeNull();
  });
});
