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

/**
 * Cascada de pertenencia (correctivo M1v2): el contenido accionable
 * pertenece a la OPP, no a la persona. Al reasignar, las tareas y avisos
 * ABIERTOS de la opp siguen a la opp (pasan al nuevo asesor); las
 * completadas y las de OTRA opp no se tocan. Si la opp queda sin asesor,
 * el admin de respaldo los custodia.
 */
describe("reassignOpportunityAdvisor — cascada de tareas y avisos", () => {
  const USER_B = "user-b";

  function seedMemberships() {
    fake.setTable("memberships", [
      { id: ADVISOR_B, user_id: USER_B, organization_id: ORG, role: "vendedor", is_active: true },
      { id: "m-admin", user_id: ADMIN, organization_id: ORG, role: "admin", is_active: true },
    ]);
  }

  it("mueve tareas y avisos ABIERTOS de la opp al nuevo asesor; no toca completadas ni otra opp", async () => {
    seedMemberships();
    fake.setTable("tasks", [
      { id: "task-open", organization_id: ORG, opportunity_id: "opp-1", assigned_user_id: ADMIN, status: "pending" },
      { id: "task-snoozed", organization_id: ORG, opportunity_id: "opp-1", assigned_user_id: ADMIN, status: "snoozed" },
      { id: "task-done", organization_id: ORG, opportunity_id: "opp-1", assigned_user_id: ADMIN, status: "completed" },
      { id: "task-other", organization_id: ORG, opportunity_id: "opp-2", assigned_user_id: ADMIN, status: "pending" },
    ]);
    fake.setTable("notifications", [
      { id: "notif-open", organization_id: ORG, opportunity_id: "opp-1", user_id: ADMIN, status: "pending" },
      { id: "notif-other", organization_id: ORG, opportunity_id: "opp-2", user_id: ADMIN, status: "pending" },
    ]);

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

    const tasks = fake.getTable("tasks");
    const byId = (id: string) => tasks.find((t) => t.id === id)!;
    expect(byId("task-open").assigned_user_id).toBe(USER_B);
    expect(byId("task-snoozed").assigned_user_id).toBe(USER_B);
    // Completada = historial: no se mueve.
    expect(byId("task-done").assigned_user_id).toBe(ADMIN);
    // Otra opp: intacta.
    expect(byId("task-other").assigned_user_id).toBe(ADMIN);

    const notifs = fake.getTable("notifications");
    expect(notifs.find((n) => n.id === "notif-open")!.user_id).toBe(USER_B);
    expect(notifs.find((n) => n.id === "notif-other")!.user_id).toBe(ADMIN);
  });

  it("reasignar a 'sin asesor' (NULL) deja las tareas abiertas en custodia del admin", async () => {
    seedMemberships();
    fake.setTable("tasks", [
      { id: "task-open", organization_id: ORG, opportunity_id: "opp-1", assigned_user_id: ADVISOR_A, status: "pending" },
    ]);
    fake.setTable("notifications", []);

    const res = await withTenantContext(
      ORG,
      () =>
        reassignOpportunityAdvisor({
          opportunityId: "opp-1",
          newMembershipId: null,
          actorUserId: ADMIN,
        }),
      { source: "test" },
    );
    expect(res.ok).toBe(true);

    const opp = fake.getTable("opportunities")[0];
    expect(opp.assigned_advisor_id).toBeNull();
    // La tarea no se pierde: la custodia el admin de respaldo.
    expect(fake.getTable("tasks")[0].assigned_user_id).toBe(ADMIN);
  });
});
