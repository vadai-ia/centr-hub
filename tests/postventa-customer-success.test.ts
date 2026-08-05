import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Segunda ranura de asignación de Post-venta — Customer Success (0047).
 *
 * Lo que protege este test es el requisito operativo central: el Customer
 * Success se SUMA al asesor, nunca lo reemplaza, y una oportunidad tiene
 * como máximo un Customer Success (asignar otro sustituye al anterior).
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

// El listado de elegibles hace un join sobre user_profiles que el fake no
// modela; se mockea para poder ejercitar la validación de elegibilidad.
vi.mock("@/lib/db/users", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/users")>();
  return { ...actual, listActiveCustomerSuccess: vi.fn() };
});

import { withTenantContext } from "@/lib/tenant/context";
import { listActiveCustomerSuccess } from "@/lib/db/users";
import {
  assignOpportunityCustomerSuccess,
  OPPORTUNITY_CUSTOMER_SUCCESS_EVENT,
} from "@/lib/services/opportunity-customer-success";

const ORG = "org-1";
const ACTOR = "admin-user-1";
const ADVISOR = "membership-vendedor";
const CS_A = "membership-cs-a";
const CS_B = "membership-cs-b";

function eligible(ids: string[]) {
  vi.mocked(listActiveCustomerSuccess).mockResolvedValue(
    ids.map((id) => ({ id, organization_id: ORG })) as never,
  );
}

function seedOpp(overrides: Record<string, unknown> = {}) {
  fake.setTable("opportunities", [
    {
      id: "opp-1",
      organization_id: ORG,
      funnel: "post_venta",
      contact_id: "contact-1",
      assigned_advisor_id: ADVISOR,
      customer_success_membership_id: null,
      last_modified_at: "2026-05-01T00:00:00Z",
      last_modified_source: "shopify",
      ...overrides,
    },
  ]);
  fake.setTable("audit_log", []);
}

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  seedOpp();
  eligible([CS_A, CS_B]);
});

function assign(membershipId: string | null) {
  return withTenantContext(
    ORG,
    () =>
      assignOpportunityCustomerSuccess({
        opportunityId: "opp-1",
        organizationId: ORG,
        newMembershipId: membershipId as never,
        actorUserId: ACTOR,
      }),
    { source: "test" },
  );
}

describe("assignOpportunityCustomerSuccess", () => {
  it("asigna el CS SIN tocar al asesor de la oportunidad", async () => {
    const res = await assign(CS_A);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.changed).toBe(true);

    const opp = fake.getTable("opportunities")[0];
    expect(opp.customer_success_membership_id).toBe(CS_A);
    // El requisito explícito: el asesor previo NO se cambia.
    expect(opp.assigned_advisor_id).toBe(ADVISOR);
  });

  it("emite el audit con actor humano y el cambio de persona", async () => {
    await assign(CS_A);

    const event = fake
      .getTable("audit_log")
      .find((a) => a.event_type === OPPORTUNITY_CUSTOMER_SUCCESS_EVENT);
    expect(event).toBeTruthy();
    expect(event?.actor_user_id).toBe(ACTOR);
    const payload = event?.payload as Record<string, unknown>;
    expect(payload?.from_membership_id).toBeNull();
    expect(payload?.to_membership_id).toBe(CS_A);
  });

  it("NO emite el audit de reasignación de asesor (no ensucia esa señal)", async () => {
    await assign(CS_A);

    const reassign = fake
      .getTable("audit_log")
      .find((a) => a.event_type === "opportunity_reassigned");
    expect(reassign).toBeUndefined();
  });

  it("un segundo CS reemplaza al anterior (una sola ranura)", async () => {
    seedOpp({ customer_success_membership_id: CS_A });

    const res = await assign(CS_B);

    expect(res.ok).toBe(true);
    const opp = fake.getTable("opportunities")[0];
    expect(opp.customer_success_membership_id).toBe(CS_B);
    expect(opp.assigned_advisor_id).toBe(ADVISOR);
  });

  it("es no-op si el CS no cambia (no emite evento)", async () => {
    seedOpp({ customer_success_membership_id: CS_A });

    const res = await assign(CS_A);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.changed).toBe(false);
    expect(fake.getTable("audit_log")).toHaveLength(0);
  });

  it("permite quitar el Customer Success (null)", async () => {
    seedOpp({ customer_success_membership_id: CS_A });

    const res = await assign(null);

    expect(res.ok).toBe(true);
    expect(
      fake.getTable("opportunities")[0].customer_success_membership_id,
    ).toBeNull();
  });

  it("rechaza la asignación en una oportunidad que NO es de Post-venta", async () => {
    seedOpp({ funnel: "venta" });

    const res = await assign(CS_A);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_postventa");
    expect(
      fake.getTable("opportunities")[0].customer_success_membership_id,
    ).toBeNull();
  });

  it("rechaza un membership que no es Customer Success activo", async () => {
    eligible([CS_A]);

    const res = await assign(ADVISOR);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("membership_not_eligible");
    expect(
      fake.getTable("opportunities")[0].customer_success_membership_id,
    ).toBeNull();
  });
});
