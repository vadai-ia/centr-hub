import { describe, expect, it } from "vitest";
import {
  opportunityReferences,
  primaryOpportunityReference,
} from "@/lib/format/opportunity-reference";
import { reopenRowToItem } from "@/lib/services/reopen-search";
import type { ReopenSearchRow } from "@/lib/db/opportunities";

/**
 * Qué folio ve el usuario en una oportunidad.
 *
 * Post-venta reportó que la plataforma enseñaba y buscaba por el folio del
 * BORRADOR (`#D1205`) en vez del folio del PEDIDO (`#1828`), que es el único
 * que el cliente conoce y el que aparece en su confirmación de compra. La
 * regla vive en un módulo puro para que card, detalle, lista del contacto,
 * Mi Día y la búsqueda de reapertura no puedan divergir.
 */
describe("opportunityReferences — manda el folio del pedido", () => {
  it("con pedido: el primario es el pedido y el borrador queda como secundario", () => {
    expect(
      opportunityReferences({
        order_reference: "#1828",
        display_reference: "#D1205",
      }),
    ).toEqual({ primary: "#1828", draft: "#D1205" });
  });

  it("sin pedido (Cotización): cae al folio del borrador y no inventa secundario", () => {
    expect(
      opportunityReferences({ order_reference: null, display_reference: "#D1205" }),
    ).toEqual({ primary: "#D1205", draft: null });
  });

  it("nunca pinta el mismo número dos veces", () => {
    expect(
      opportunityReferences({
        order_reference: "#1828",
        display_reference: "#1828",
      }),
    ).toEqual({ primary: "#1828", draft: null });
  });

  it("trata vacíos y espacios como ausencia (no muestra una cadena vacía)", () => {
    expect(
      opportunityReferences({ order_reference: "   ", display_reference: "" }),
    ).toEqual({ primary: null, draft: null });
    expect(
      opportunityReferences({ order_reference: "  #1828 ", display_reference: null }),
    ).toEqual({ primary: "#1828", draft: null });
  });

  it("tolera el campo ausente (filas que aún no pasan por la resolución en lote)", () => {
    expect(primaryOpportunityReference({ display_reference: "#D1205" })).toBe(
      "#D1205",
    );
  });
});

describe("búsqueda de reapertura — muestra el folio del pedido", () => {
  const row = (over: Partial<ReopenSearchRow>): ReopenSearchRow => ({
    id: "o-1",
    funnel: "post_venta",
    stage_id: "s-1",
    stage_name: "Envío en curso",
    contact_id: "c-1",
    display_reference: "#D1205",
    shopify_order_id: "6001",
    order_reference: "#1828",
    last_modified_at: "2026-09-01T00:00:00.000Z",
    won_at: null,
    lost_at: null,
    cancelled_at: null,
    resolved_at: null,
    reopened_at: null,
    assigned_advisor_id: null,
    contact: { full_name: "Roberto Hernández", phone: "+5215500000000" },
    ...over,
  });

  it("usa el número del pedido, no el del borrador", () => {
    expect(reopenRowToItem(row({})).reference).toBe("#1828");
  });

  it("cae al borrador cuando la opp todavía no tiene pedido", () => {
    expect(
      reopenRowToItem(row({ order_reference: null, shopify_order_id: null }))
        .reference,
    ).toBe("#D1205");
  });

  it("si el pedido no está en la base, no inventa: cae al borrador", () => {
    expect(reopenRowToItem(row({ order_reference: null })).reference).toBe(
      "#D1205",
    );
  });
});
