import { describe, expect, it } from "vitest";
import { decideLeadClientMerge, namesCompatible } from "@/lib/services/contact-lead-merge";
import type { ContactRow } from "@/lib/types/database";

/**
 * Decisión de fusión lead → cliente (0054).
 *
 * Los casos vienen de datos reales de Centr: tres pares lead+cliente con el
 * mismo teléfono que SÍ son la misma persona (el cliente se creó en Shopify sin
 * teléfono y se le agregó después), y pares con el mismo número que NO deben
 * fusionarse (dos clientes de Shopify; personas distintas que comparten número).
 */

const PHONE = "+525512345678";

function contact(over: Partial<ContactRow> & { id: string }): ContactRow {
  return {
    organization_id: "org",
    full_name: null,
    email: null,
    phone: PHONE,
    address: null,
    internal_note: null,
    shopify_tags: [],
    shopify_state: null,
    assigned_advisor_id: null,
    shopify_customer_id: null,
    whaapy_contact_id: null,
    field_metadata: {},
    last_modified_at: "2026-09-10T00:00:00Z",
    last_modified_source: "shopify",
    missing_phone: false,
    deleted_in_shopify: false,
    deleted_in_whaapy: false,
    anonymized_at: null,
    created_at: "2026-09-10T00:00:00Z",
    updated_at: "2026-09-10T00:00:00Z",
    ...over,
  } as unknown as ContactRow;
}

const client = (over: Partial<ContactRow> = {}) =>
  contact({ id: "client", shopify_customer_id: "shop-1", full_name: "Daniela Padilla", ...over });
const lead = (over: Partial<ContactRow> = {}) =>
  contact({ id: "lead", whaapy_contact_id: "wa-1", full_name: "Dani 🤗", ...over });

describe("namesCompatible", () => {
  it.each([
    ["Dani 🤗", "Daniela Padilla"],
    ["Omar Cabrera", "Omar Antonio Cabrera"],
    ["Lulu Ruiz", "Lulu Ruiz"],
    ["Arq. Juan Pérez", "Juan Pérez"],
    ["gerardo villalobos", "Gerardo I. Villalobos"],
    ["JOSÉ", "Jose Luis Rivera"],
  ])("SÍ son compatibles: %s ↔ %s", (a, b) => {
    expect(namesCompatible(a, b)).toBe(true);
  });

  it.each([
    ["BRENDA CHAVIRA", "César Mendoza"],
    // Compartir apellido NO es identidad: familia con el mismo teléfono.
    ["Diego Fuentes", "Enrique Fuentes"],
    ["Eduardo Del razo", "Elizabeth Maceda Priego"],
  ])("NO son compatibles: %s ↔ %s", (a, b) => {
    expect(namesCompatible(a, b)).toBe(false);
  });

  it("un nombre vacío o solo emojis no es evidencia en contra", () => {
    expect(namesCompatible(null, "Daniela Padilla")).toBe(true);
    expect(namesCompatible("🤗🔥", "Daniela Padilla")).toBe(true);
  });
});

describe("decideLeadClientMerge", () => {
  it("fusiona el caso real: cliente de Shopify + un único lead de WhatsApp con su teléfono", () => {
    const d = decideLeadClientMerge(client(), [client(), lead()]);
    expect(d).toEqual({ action: "merge", lead: expect.objectContaining({ id: "lead" }) });
  });

  it("NO fusiona dos clientes de Shopify (un contacto no puede tener dos shopify_customer_id)", () => {
    const other = contact({ id: "c2", shopify_customer_id: "shop-2", full_name: "Daniela Padilla" });
    expect(decideLeadClientMerge(client(), [client(), other])).toEqual({
      action: "skip",
      reason: "other_is_client",
    });
  });

  it("NO fusiona si hay tres o más tarjetas con el número (ambiguo)", () => {
    const lead2 = contact({ id: "lead2", full_name: "Daniela" });
    expect(decideLeadClientMerge(client(), [client(), lead(), lead2])).toEqual({
      action: "skip",
      reason: "ambiguous_phone",
    });
  });

  it("NO fusiona personas distintas que comparten número", () => {
    const d = decideLeadClientMerge(client({ full_name: "Enrique Fuentes" }), [
      client({ full_name: "Enrique Fuentes" }),
      lead({ full_name: "Diego Fuentes" }),
    ]);
    expect(d).toEqual({ action: "skip", reason: "name_mismatch" });
  });

  it("NO fusiona si traen dos identidades de Whaapy distintas", () => {
    const d = decideLeadClientMerge(client({ whaapy_contact_id: "wa-9" }), [
      client({ whaapy_contact_id: "wa-9" }),
      lead({ whaapy_contact_id: "wa-1" }),
    ]);
    expect(d).toEqual({ action: "skip", reason: "whaapy_identity_conflict" });
  });

  it("solo actúa sobre CLIENTES con teléfono", () => {
    expect(decideLeadClientMerge(lead(), [lead()])).toEqual({ action: "skip", reason: "not_a_client" });
    expect(decideLeadClientMerge(client({ phone: null }), [])).toEqual({ action: "skip", reason: "no_phone" });
  });

  it("sin nadie más con el número, no hay nada que fusionar", () => {
    expect(decideLeadClientMerge(client(), [client()])).toEqual({
      action: "skip",
      reason: "no_lead_with_phone",
    });
  });

  it("no toca contactos anonimizados (ARCO)", () => {
    expect(
      decideLeadClientMerge(client(), [client(), lead({ anonymized_at: "2026-09-01T00:00:00Z" })]),
    ).toEqual({ action: "skip", reason: "lead_anonymized" });
  });
});
