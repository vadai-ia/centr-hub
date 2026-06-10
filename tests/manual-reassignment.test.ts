import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Reasignación MANUAL del asesor de una oportunidad (M9.2, núcleo
 * compartido `reassignOpportunityAdvisor`).
 *
 * Verifica el contrato "marcado como manual": al reasignar, se emite el
 * audit `opportunity_reassigned` con `actor_user_id` NO nulo — que es
 * exactamente lo que la guarda del hook 0022 detecta para NO pisar la
 * asignación. También que la opp queda con `last_modified_source =
 * 'platform'` y el nuevo asesor.
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

import { withTenantContext } from "@/lib/tenant/context";
import {
  reassignOpportunityAdvisor,
  OPPORTUNITY_REASSIGNED_EVENT,
} from "@/lib/services/opportunity-reassignment";

const ORG = "org-1";
const ADMIN = "admin-user-1";
const ADVISOR_A = "membership-a";
const ADVISOR_B = "membership-b";

function seedOpp() {
  fake.setTable("opportunities", [
    {
      id: "opp-1",
      organization_id: ORG,
      funnel: "venta",
      contact_id: "contact-1",
      assigned_advisor_id: ADVISOR_A,
      last_modified_at: "2026-05-01T00:00:00Z",
      last_modified_source: "shopify",
    },
  ]);
  fake.setTable("audit_log", []);
}

beforeEach(() => {
  fake.reset();
  seedOpp();
});

describe("reassignOpportunityAdvisor (marcado como manual)", () => {
  it("reasigna al nuevo asesor y emite opportunity_reassigned con actor humano", async () => {
    const res = await withTenantContext(
      ORG,
      () =>
        reassignOpportunityAdvisor({
          opportunityId: "opp-1",
          newMembershipId: ADVISOR_B,
          actorUserId: ADMIN,
        }),
      { source: "test" },
    );

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.changed).toBe(true);

    const opp = fake.getTable("opportunities")[0];
    expect(opp.assigned_advisor_id).toBe(ADVISOR_B);
    expect(opp.last_modified_source).toBe("platform");

    const audits = fake.getTable("audit_log");
    const event = audits.find(
      (a) => a.event_type === OPPORTUNITY_REASSIGNED_EVENT,
    );
    expect(event, "debe registrar el evento de reasignación").toBeTruthy();
    // CRÍTICO: actor humano no-nulo → la guarda del hook lo lee como manual.
    expect(event?.actor_user_id).toBe(ADMIN);
    expect((event?.payload as Record<string, unknown>)?.to_membership_id).toBe(
      ADVISOR_B,
    );
    expect((event?.payload as Record<string, unknown>)?.from_membership_id).toBe(
      ADVISOR_A,
    );
  });

  it("es no-op si el asesor no cambia (no emite evento)", async () => {
    const res = await withTenantContext(
      ORG,
      () =>
        reassignOpportunityAdvisor({
          opportunityId: "opp-1",
          newMembershipId: ADVISOR_A,
          actorUserId: ADMIN,
        }),
      { source: "test" },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.changed).toBe(false);
    expect(fake.getTable("audit_log")).toHaveLength(0);
  });

  it("reporta entity_not_found si la opp no existe", async () => {
    const res = await withTenantContext(
      ORG,
      () =>
        reassignOpportunityAdvisor({
          opportunityId: "opp-inexistente",
          newMembershipId: ADVISOR_B,
          actorUserId: ADMIN,
        }),
      { source: "test" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("entity_not_found");
  });
});
