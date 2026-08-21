import { describe, expect, it } from "vitest";
import { toTemplateOrderParam } from "@/lib/services/order-reference";

/**
 * El `#` del número de pedido pertenece al TEXTO de la plantilla aprobada
 * ("tu pedido #{{2}} ha sido entregado"), no al dato. `orders.shopify_name`
 * lo trae incluido, así que pasarlo tal cual renderiza "pedido ##1759" en
 * el WhatsApp del cliente.
 */
describe("toTemplateOrderParam", () => {
  it("quita el # que aporta la plantilla", () => {
    expect(toTemplateOrderParam("#1759")).toBe("1759");
  });

  it("es idempotente si el valor ya viene sin #", () => {
    expect(toTemplateOrderParam("1759")).toBe("1759");
  });

  it("null se propaga (la variable queda vacía, no '#')", () => {
    expect(toTemplateOrderParam(null)).toBeNull();
  });

  it("no inventa un valor cuando solo hay símbolos o espacios", () => {
    expect(toTemplateOrderParam("#")).toBeNull();
    expect(toTemplateOrderParam("   ")).toBeNull();
    expect(toTemplateOrderParam("")).toBeNull();
  });

  it("solo recorta el prefijo — no toca el resto de la referencia", () => {
    expect(toTemplateOrderParam("  #1759  ")).toBe("1759");
    expect(toTemplateOrderParam("##1759")).toBe("1759");
    expect(toTemplateOrderParam("#CENTR-1759")).toBe("CENTR-1759");
    expect(toTemplateOrderParam("1759#A")).toBe("1759#A");
  });
});
