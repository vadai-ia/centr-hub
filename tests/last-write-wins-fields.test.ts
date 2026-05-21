import { describe, expect, it } from "vitest";
import {
  reconcileContactFields,
  type FieldProposal,
} from "@/lib/services/last-write-wins";
import type { ContactRow, Json } from "@/lib/types/database";

function makeContact(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: "c1",
    organization_id: "o1",
    full_name: "Antiguo",
    email: "antiguo@example.com",
    phone: "+525500000000",
    address: null,
    internal_note: "",
    shopify_tags: [],
    shopify_state: null,
    assigned_advisor_id: null,
    shopify_customer_id: null,
    whaapy_contact_id: null,
    field_metadata: {} as Json,
    last_modified_at: "2026-01-01T00:00:00Z",
    last_modified_source: "shopify",
    missing_phone: false,
    deleted_in_shopify: false,
    deleted_in_whaapy: false,
    anonymized_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("reconcileContactFields — R3 LWW por campo", () => {
  it("primer valor para un campo se aplica (sin metadata previa)", () => {
    const contact = makeContact();
    const proposals: FieldProposal[] = [
      { field: "full_name", value: "Nuevo", updatedAt: "2026-05-01T00:00:00Z", source: "shopify" },
    ];
    const result = reconcileContactFields(contact, proposals);
    expect(result.patch.full_name).toBe("Nuevo");
    expect(result.decisions[0].reason).toBe("first_value");
  });

  it("update con timestamp posterior se aplica", () => {
    const contact = makeContact({
      field_metadata: {
        full_name: { updated_at: "2026-01-01T00:00:00Z", source: "shopify" },
      } as Json,
    });
    const proposals: FieldProposal[] = [
      { field: "full_name", value: "MásNuevo", updatedAt: "2026-05-01T00:00:00Z", source: "whaapy" },
    ];
    const result = reconcileContactFields(contact, proposals);
    expect(result.patch.full_name).toBe("MásNuevo");
    expect(result.decisions[0].reason).toBe("newer");
  });

  it("update con timestamp anterior es ignorado (orden cronológico)", () => {
    const contact = makeContact({
      field_metadata: {
        full_name: { updated_at: "2026-05-01T00:00:00Z", source: "shopify" },
      } as Json,
    });
    const proposals: FieldProposal[] = [
      { field: "full_name", value: "Viejo", updatedAt: "2026-04-01T00:00:00Z", source: "whaapy" },
    ];
    const result = reconcileContactFields(contact, proposals);
    expect(result.patch.full_name).toBeUndefined();
    expect(result.decisions[0].reason).toBe("older_ignored");
  });

  it("borrado intencional propagado (campo vacío en update reciente SOBRESCRIBE)", () => {
    const contact = makeContact({
      field_metadata: {
        internal_note: { updated_at: "2026-01-01T00:00:00Z", source: "shopify" },
      } as Json,
    });
    const proposals: FieldProposal[] = [
      { field: "internal_note", value: "", updatedAt: "2026-05-01T00:00:00Z", source: "whaapy" },
    ];
    const result = reconcileContactFields(contact, proposals);
    expect(result.patch.internal_note).toBe(null);
    expect(result.decisions[0].reason).toBe("empty_overwrite");
  });

  it("granularidad por campo: un campo más viejo y otro más nuevo en el mismo payload", () => {
    const contact = makeContact({
      field_metadata: {
        full_name: { updated_at: "2026-05-01T00:00:00Z", source: "whaapy" }, // ya nuevo
        email: { updated_at: "2026-01-01T00:00:00Z", source: "shopify" },     // viejo
      } as Json,
    });
    const proposals: FieldProposal[] = [
      { field: "full_name", value: "GanaWhaapy", updatedAt: "2026-04-01T00:00:00Z", source: "shopify" },
      { field: "email", value: "mas-nuevo@x.com", updatedAt: "2026-05-01T00:00:00Z", source: "shopify" },
    ];
    const result = reconcileContactFields(contact, proposals);
    expect(result.patch.full_name).toBeUndefined(); // ignorado, Whaapy ya tenía más nuevo
    expect(result.patch.email).toBe("mas-nuevo@x.com");
  });

  it("excepción match inicial (Shopify gana pero vacío NO borra)", () => {
    const contact = makeContact({
      full_name: "ValorMaestro",
      field_metadata: {
        full_name: { updated_at: "2025-12-01T00:00:00Z", source: "whaapy" },
      } as Json,
    });
    const proposals: FieldProposal[] = [
      // valor vacío: NO debe borrar
      { field: "full_name", value: "", updatedAt: "2026-05-01T00:00:00Z", source: "shopify" },
      // valor no-vacío: sí debe aplicar
      { field: "email", value: "shopify@x.com", updatedAt: "2026-05-01T00:00:00Z", source: "shopify" },
    ];
    const result = reconcileContactFields(contact, proposals, { isInitialMatch: true });
    expect(result.patch.full_name).toBeUndefined(); // preservado
    expect(result.patch.email).toBe("shopify@x.com");
    expect(result.decisions[0].reason).toBe("initial_match_preserve_value");
    expect(result.decisions[1].reason).toBe("initial_match_shopify_priority");
  });

  it("identificadores externos NUNCA se sobrescriben por LWW", () => {
    const contact = makeContact({ shopify_customer_id: "999" });
    const proposals: FieldProposal[] = [
      {
        field: "shopify_customer_id" as never,
        value: null,
        updatedAt: "2026-05-01T00:00:00Z",
        source: "shopify",
      },
    ];
    const result = reconcileContactFields(contact, proposals);
    expect(result.decisions[0].reason).toBe("blocked_external_id");
    expect(result.patch.shopify_customer_id).toBeUndefined();
  });

  it("metadata se preserva campo por campo en el patch final", () => {
    const contact = makeContact({
      field_metadata: {
        existing: { updated_at: "2024-01-01T00:00:00Z", source: "platform" },
      } as Json,
    });
    const proposals: FieldProposal[] = [
      { field: "email", value: "z@x.com", updatedAt: "2026-05-01T00:00:00Z", source: "shopify" },
    ];
    const result = reconcileContactFields(contact, proposals);
    expect(result.nextFieldMetadata).toMatchObject({
      existing: { updated_at: "2024-01-01T00:00:00Z", source: "platform" },
      email: { updated_at: "2026-05-01T00:00:00Z", source: "shopify" },
    });
  });
});
