import { describe, expect, it } from "vitest";
import {
  contactDisplayName,
  formatRelative,
  lastActivityISO,
  resolveAdvisor,
  systemIndicators,
} from "@/app/(dashboard)/contactos/utils";
import type { ContactListRow } from "@/lib/db/contacts";

/**
 * Helpers de display del listado de Contactos (M6 — B2).
 * Tests puros — sin BD ni mocks.
 */

function row(overrides: Partial<ContactListRow> = {}): ContactListRow {
  return {
    id: "c-1",
    full_name: "Ana López",
    email: "ana@example.com",
    phone: "+5215551111111",
    shopify_customer_id: null,
    whaapy_contact_id: null,
    contactType: "lead",
    assigned_advisor_id: null,
    last_modified_at: "2026-05-01T10:00:00.000Z",
    last_whaapy_activity_at: null,
    missing_phone: false,
    deleted_in_shopify: false,
    deleted_in_whaapy: false,
    anonymized_at: null,
    ...overrides,
  };
}

describe("contactDisplayName", () => {
  it("nombre normal", () => {
    expect(contactDisplayName(row())).toBe("Ana López");
  });

  it("anonimizado muestra placeholder con id corto", () => {
    const r = row({
      id: "abcd1234-5678-90ab-cdef-1234567890ab",
      anonymized_at: "2026-05-01T10:00:00Z",
    });
    expect(contactDisplayName(r)).toBe("Cliente anonimizado #abcd1234");
  });

  it("sin full_name usa email como fallback", () => {
    expect(contactDisplayName(row({ full_name: null }))).toBe("ana@example.com");
  });

  it("sin full_name ni email usa phone", () => {
    expect(
      contactDisplayName(row({ full_name: null, email: null, phone: "+521234" })),
    ).toBe("+521234");
  });

  it("sin nada cae a placeholder genérico", () => {
    expect(
      contactDisplayName(
        row({ full_name: null, email: null, phone: null }),
      ),
    ).toBe("Contacto sin nombre");
  });
});

describe("systemIndicators", () => {
  it("solo Shopify", () => {
    const r = row({ shopify_customer_id: "s-1" });
    expect(systemIndicators(r)).toEqual({
      inShopify: true,
      inWhaapy: false,
      presence: "shopify_only",
    });
  });

  it("solo Whaapy", () => {
    const r = row({ whaapy_contact_id: "w-1" });
    expect(systemIndicators(r)).toEqual({
      inShopify: false,
      inWhaapy: true,
      presence: "whaapy_only",
    });
  });

  it("ambos", () => {
    const r = row({ shopify_customer_id: "s-1", whaapy_contact_id: "w-1" });
    expect(systemIndicators(r).presence).toBe("both");
  });

  it("ninguno (caso teórico edge)", () => {
    expect(systemIndicators(row()).presence).toBe("none");
  });
});

describe("lastActivityISO", () => {
  it("prefiere last_whaapy_activity_at si existe", () => {
    const r = row({
      last_modified_at: "2026-05-01T10:00:00Z",
      last_whaapy_activity_at: "2026-05-02T10:00:00Z",
    });
    expect(lastActivityISO(r)).toBe("2026-05-02T10:00:00Z");
  });

  it("cae a last_modified_at cuando whaapy_activity es null", () => {
    expect(lastActivityISO(row())).toBe("2026-05-01T10:00:00.000Z");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-05-10T12:00:00.000Z");

  it("hace minutos", () => {
    expect(formatRelative("2026-05-10T11:30:00.000Z", now)).toMatch(/30 min/);
  });

  it("hace horas", () => {
    expect(formatRelative("2026-05-10T08:00:00.000Z", now)).toMatch(/4 h/);
  });

  it("ayer", () => {
    expect(formatRelative("2026-05-09T12:00:00.000Z", now)).toBe("ayer");
  });

  it("hace varios días", () => {
    expect(formatRelative("2026-05-07T12:00:00.000Z", now)).toMatch(/3 días/);
  });

  it("más de 7 días → fecha corta", () => {
    expect(formatRelative("2026-04-01T12:00:00.000Z", now)).toMatch(/abr/);
  });

  it("futuro (caso defensivo)", () => {
    expect(formatRelative("2030-01-01T00:00:00.000Z", now)).toBe("en el futuro");
  });
});

describe("resolveAdvisor", () => {
  const advisors = [
    { membershipId: "m-1", userId: "u-1", fullName: "Regina", color: "#aaa" },
    { membershipId: "m-2", userId: "u-2", fullName: "Mayor", color: "#bbb" },
  ];

  it("null id → Sin asignar", () => {
    const r = resolveAdvisor(null, advisors);
    expect(r.fullName).toBe("Sin asignar");
    expect(r.isUnassigned).toBe(true);
  });

  it("id existente → nombre + color", () => {
    expect(resolveAdvisor("m-1", advisors)).toEqual({
      fullName: "Regina",
      color: "#aaa",
      isUnassigned: false,
    });
  });

  it("id desconocido (advisor desactivado / sistema) → fallback histórico", () => {
    const r = resolveAdvisor("m-ghost", advisors);
    expect(r.fullName).toBe("Asesor histórico");
    expect(r.isUnassigned).toBe(false);
  });
});
