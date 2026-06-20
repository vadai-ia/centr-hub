import { describe, expect, it } from "vitest";
import {
  contactDisplayName,
  contactIsCustomer,
  deriveDisplayAmount,
  deriveOriginIndicator,
  formatAmount,
  resolveAdvisor,
} from "../app/(dashboard)/pipeline/utils";
import type { KanbanOpportunity } from "@/lib/db/opportunities";

/**
 * Utilidades presentacionales del kanban (M5). Probadas porque
 * caso "sin monto" y "sin asignar" no deben rendir `$0` ni `null` y
 * son edge cases reales documentados en el prompt.
 */

function makeOpp(overrides: Partial<KanbanOpportunity> = {}): KanbanOpportunity {
  return {
    id: "opp-1",
    organization_id: "org-1",
    funnel: "venta",
    stage_id: "stage-1",
    contact_id: "contact-1",
    assigned_advisor_id: "membership-1",
    shopify_draft_order_id: "do-1",
    shopify_order_id: null,
    display_reference: "#D1",
    actual_amount: null,
    estimated_amount: null,
    currency: "MXN",
    updated_at: "2026-05-01T10:00:00.000Z",
    last_modified_at: "2026-05-01T10:00:00.000Z",
    last_modified_source: "shopify",
    cancelled_at: null,
    resolved_at: null,
    resolved_by_user_id: null,
    resolution_note: null,
    contact: {
      id: "contact-1",
      full_name: "Ana Pérez",
      phone: "+525555555555",
      email: "ana@example.com",
      shopify_customer_id: "sc-123",
      whaapy_contact_id: null,
      shopify_tags: ["pepe"],
    },
    ...overrides,
  };
}

describe("formatAmount", () => {
  it("formatea MXN sin centavos", () => {
    const s = formatAmount("12500.00", "MXN");
    expect(s).toMatch(/12[\.,]500/);
  });

  it("devuelve null para vacío/nulo", () => {
    expect(formatAmount(null)).toBeNull();
    expect(formatAmount("")).toBeNull();
  });

  it("devuelve null para input no numérico", () => {
    expect(formatAmount("abc")).toBeNull();
  });
});

describe("deriveDisplayAmount", () => {
  it("prefiere actual_amount cuando existe", () => {
    const opp = makeOpp({ actual_amount: "10000.00", estimated_amount: "9000.00" });
    const d = deriveDisplayAmount(opp);
    expect(d.isEstimated).toBe(false);
    expect(d.isMissing).toBe(false);
  });

  it("cae a estimated_amount si no hay actual", () => {
    const opp = makeOpp({ actual_amount: null, estimated_amount: "9000.00" });
    const d = deriveDisplayAmount(opp);
    expect(d.isEstimated).toBe(true);
    expect(d.isMissing).toBe(false);
  });

  it("marca Sin monto cuando ambos faltan", () => {
    const opp = makeOpp({ actual_amount: null, estimated_amount: null });
    const d = deriveDisplayAmount(opp);
    expect(d.isMissing).toBe(true);
    expect(d.text).toBe("Sin monto");
  });
});

describe("deriveOriginIndicator", () => {
  it("shopify cuando hay draft_order_id", () => {
    expect(deriveOriginIndicator(makeOpp({ shopify_draft_order_id: "d" }))).toBe(
      "shopify",
    );
  });
  it("shopify cuando solo hay order_id (ganada paid sin DO)", () => {
    expect(
      deriveOriginIndicator(
        makeOpp({ shopify_draft_order_id: null, shopify_order_id: "ord-1" }),
      ),
    ).toBe("shopify");
  });
  it("whaapy/auto cuando no hay ninguno (auto-creada R12)", () => {
    expect(
      deriveOriginIndicator(
        makeOpp({ shopify_draft_order_id: null, shopify_order_id: null }),
      ),
    ).toBe("whaapy_or_auto");
  });
});

describe("resolveAdvisor", () => {
  const advisors = [
    {
      membershipId: "m-1",
      userId: "u-1",
      fullName: "Gina",
      color: "#10B981",
    },
  ];
  it("resuelve por membershipId", () => {
    const a = resolveAdvisor("m-1", advisors);
    expect(a.fullName).toBe("Gina");
    expect(a.isUnassigned).toBe(false);
  });
  it("marca Sin asignar cuando assigned_advisor_id es null", () => {
    const a = resolveAdvisor(null, advisors);
    expect(a.isUnassigned).toBe(true);
    expect(a.fullName).toBe("Sin asignar");
  });
  it("fallback cuando el membership ya no está en el dropdown", () => {
    const a = resolveAdvisor("m-99", advisors);
    expect(a.isUnassigned).toBe(false);
    expect(a.fullName).toBe("Asesor");
  });
});

describe("contactDisplayName / contactIsCustomer", () => {
  it("contactDisplayName prefiere full_name", () => {
    expect(
      contactDisplayName({
        id: "c",
        full_name: "Ana",
        phone: "+5255",
        email: "a@b",
        shopify_customer_id: null,
        whaapy_contact_id: null,
        shopify_tags: [],
      }),
    ).toBe("Ana");
  });

  it("contactDisplayName fallback a phone si full_name vacío", () => {
    expect(
      contactDisplayName({
        id: "c",
        full_name: "",
        phone: "+5251234",
        email: null,
        shopify_customer_id: null,
        whaapy_contact_id: null,
        shopify_tags: [],
      }),
    ).toBe("+5251234");
  });

  it("contactDisplayName 'Contacto desconocido' si contact es null", () => {
    expect(contactDisplayName(null)).toBe("Contacto desconocido");
  });

  it("contactIsCustomer true cuando hay shopify_customer_id (derivación O12)", () => {
    expect(
      contactIsCustomer({
        id: "c",
        full_name: "Ana",
        phone: "+5251",
        email: null,
        shopify_customer_id: "sc-1",
        whaapy_contact_id: null,
        shopify_tags: [],
      }),
    ).toBe(true);
  });

  it("contactIsCustomer false sin shopify_customer_id (lead)", () => {
    expect(
      contactIsCustomer({
        id: "c",
        full_name: "Ana",
        phone: "+5251",
        email: null,
        shopify_customer_id: null,
        whaapy_contact_id: null,
        shopify_tags: [],
      }),
    ).toBe(false);
  });
});
