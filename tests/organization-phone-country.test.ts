import { describe, expect, it } from "vitest";
import { readOrganizationPhoneCountry } from "@/lib/services/organization-phone-country";
import { normalizePhone } from "@/lib/services/identity-matching";

/**
 * Lada por ORGANIZACIÓN al capturar un teléfono sin formato internacional.
 *
 * El caso que lo motivó: en Centr Colombia, un número local tecleado a mano
 * nacía como +52 — un teléfono mexicano que no existe y al que nadie puede
 * escribir. Reportado en la junta con el equipo.
 */

describe("readOrganizationPhoneCountry", () => {
  it("lee el país configurado", () => {
    expect(readOrganizationPhoneCountry({ defaults: { phone_country: "CO" } })).toBe("CO");
  });

  it("normaliza minúsculas y espacios", () => {
    expect(readOrganizationPhoneCountry({ defaults: { phone_country: " co " } })).toBe("CO");
  });

  it("sin configurar cae a MX — las tiendas existentes no cambian", () => {
    expect(readOrganizationPhoneCountry(null)).toBe("MX");
    expect(readOrganizationPhoneCountry({ defaults: {} })).toBe("MX");
  });

  it("un valor basura cae a MX: con un país inválido NINGÚN número local pasaría", () => {
    expect(readOrganizationPhoneCountry({ defaults: { phone_country: "Colombia" } })).toBe("MX");
    expect(readOrganizationPhoneCountry({ defaults: { phone_country: 57 } })).toBe("MX");
  });
});

describe("el país elegido cambia cómo se interpreta un número LOCAL", () => {
  it("el mismo número local da +57 en Colombia y +52 en México", () => {
    const local = "310 456 7890";
    expect(normalizePhone(local, "CO")).toBe("+573104567890");
    expect(normalizePhone(local, "MX")).toBe("+523104567890");
  });

  it("un número que YA trae lada internacional se respeta, venga de donde venga", () => {
    // Es la garantía de que esto solo afecta a lo tecleado sin lada: los
    // números que llegan de Shopify o Whaapy ya vienen en E.164.
    expect(normalizePhone("+525512345678", "CO")).toBe("+525512345678");
    expect(normalizePhone("+573104567890", "MX")).toBe("+573104567890");
  });
});
