import { describe, expect, it } from "vitest";
import { readOrganizationCurrency } from "@/lib/services/organization-currency";

/**
 * La moneda de los AGREGADOS sale de la organización, no de una constante.
 *
 * El caso que lo motivó: Centr Colombia vende en COP (su Shopify lo reporta
 * así) y el dashboard etiquetaba sus importes como MXN. Un monto mostrado en
 * una moneda que no es suya es peor que no mostrarlo: se lee como un número
 * correcto y nadie sospecha.
 */

describe("readOrganizationCurrency", () => {
  it("lee la moneda configurada de la organización", () => {
    expect(readOrganizationCurrency({ defaults: { currency: "COP" } })).toBe("COP");
  });

  it("normaliza a mayúsculas y sin espacios (lo que capture el admin)", () => {
    expect(readOrganizationCurrency({ defaults: { currency: " cop " } })).toBe("COP");
  });

  it("sin configurar cae a MXN — las orgs existentes no cambian de comportamiento", () => {
    expect(readOrganizationCurrency(null)).toBe("MXN");
    expect(readOrganizationCurrency({})).toBe("MXN");
    expect(readOrganizationCurrency({ defaults: {} })).toBe("MXN");
  });

  it("un valor basura NO se propaga: Intl lanzaría y tumbaría el dashboard", () => {
    expect(readOrganizationCurrency({ defaults: { currency: "pesos" } })).toBe("MXN");
    expect(readOrganizationCurrency({ defaults: { currency: 42 } })).toBe("MXN");
    expect(readOrganizationCurrency({ defaults: { currency: "" } })).toBe("MXN");
  });
});
