import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Timeline unificado (M6 — B1).
 *
 * Verifica:
 *   - Fan-out paralelo sobre fuentes y merge por occurredAt DESC.
 *   - Scope contacto: trae cambios de etapa de TODAS las opps del
 *     contacto + orders + tareas + activities + audits.
 *   - Scope oportunidad: scoped a esa opp + activities/audits con
 *     entity_type='opportunity'.
 *   - Whitelist de audit_log: solo event_types aprobados entran.
 *   - Mapeo de kinds (stage_change, order_paid, manual_note, etc.).
 *   - Eventos técnicos (sync_loop_prevented, *_intent_recorded) NO
 *     entran al timeline.
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

import { withTenantContext } from "@/lib/tenant/context";
import {
  getContactTimeline,
  getOpportunityTimeline,
} from "@/lib/services/timeline";

const ORG = "org-1";

function seedStages() {
  fake.setTable("pipeline_stages", [
    {
      id: "stage-cot",
      organization_id: ORG,
      funnel: "venta",
      name: "Cotización",
      color: "#34D399",
      position: 6,
      is_won: false,
      is_lost: false,
      is_initial: false,
      is_active: true,
    },
    {
      id: "stage-ganada",
      organization_id: ORG,
      funnel: "venta",
      name: "Ganada",
      color: "#10B981",
      position: 8,
      is_won: true,
      is_lost: false,
      is_initial: false,
      is_active: true,
    },
    {
      id: "stage-perdida",
      organization_id: ORG,
      funnel: "venta",
      name: "Perdida",
      color: "#EF4444",
      position: 9,
      is_won: false,
      is_lost: true,
      is_initial: false,
      is_active: true,
    },
  ]);
}

beforeEach(() => {
  fake.reset();
  seedStages();
});

describe("getContactTimeline", () => {
  it("agrupa eventos de múltiples fuentes y ordena por ts DESC", async () => {
    fake.setTable("opportunities", [
      { id: "opp-1", organization_id: ORG, contact_id: "c-1" },
      { id: "opp-2", organization_id: ORG, contact_id: "c-1" },
    ]);
    fake.setTable("opportunity_stage_history", [
      {
        id: "h-1",
        organization_id: ORG,
        opportunity_id: "opp-1",
        from_stage_id: null,
        to_stage_id: "stage-cot",
        changed_by_user_id: "u-1",
        context: "manual",
        changed_at: "2026-05-01T10:00:00.000Z",
      },
      {
        id: "h-2",
        organization_id: ORG,
        opportunity_id: "opp-1",
        from_stage_id: "stage-cot",
        to_stage_id: "stage-ganada",
        changed_by_user_id: null,
        context: "webhook",
        changed_at: "2026-05-05T10:00:00.000Z",
      },
    ]);
    fake.setTable("orders", [
      {
        id: "ord-1",
        organization_id: ORG,
        contact_id: "c-1",
        opportunity_id: "opp-1",
        shopify_order_id: "5001",
        shopify_name: "#5001",
        financial_status: "paid",
        total_amount: "1234.56",
        currency: "MXN",
        paid_at: "2026-05-05T11:00:00.000Z",
        cancelled_at: null,
        created_at: "2026-05-05T09:00:00.000Z",
        cancellation_reason: null,
      },
    ]);
    fake.setTable("tasks", [
      {
        id: "t-1",
        organization_id: ORG,
        contact_id: "c-1",
        opportunity_id: null,
        assigned_user_id: "u-1",
        task_type: "follow_up",
        title: "Llamar al cliente",
        description: null,
        status: "pending",
        created_at: "2026-05-03T10:00:00.000Z",
        completed_at: null,
        due_at: null,
        snoozed_until: null,
      },
    ]);
    fake.setTable("activities", [
      {
        id: "act-1",
        organization_id: ORG,
        contact_id: "c-1",
        opportunity_id: null,
        activity_type: "manual_note",
        description: "Cliente pidió cotización extra",
        payload: {},
        triggered_by_user_id: "u-1",
        created_at: "2026-05-04T10:00:00.000Z",
      },
    ]);

    const events = await withTenantContext(ORG, async () => {
      return getContactTimeline("c-1");
    });

    expect(events.length).toBeGreaterThan(0);
    // Orden descendente por occurredAt
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].occurredAt >= events[i].occurredAt).toBe(true);
    }

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("stage_change");
    expect(kinds).toContain("order_paid");
    expect(kinds).toContain("task_created");
    expect(kinds).toContain("manual_note");
  });

  it("contacto sin opps: no falla y solo trae orders/tasks/activities/audits del contacto", async () => {
    fake.setTable("opportunities", []);
    fake.setTable("activities", [
      {
        id: "act-1",
        organization_id: ORG,
        contact_id: "c-2",
        opportunity_id: null,
        activity_type: "manual_note",
        description: "Nota inicial",
        payload: {},
        triggered_by_user_id: null,
        created_at: "2026-05-01T10:00:00.000Z",
      },
    ]);

    const events = await withTenantContext(ORG, async () => {
      return getContactTimeline("c-2");
    });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("manual_note");
  });
});

describe("getOpportunityTimeline", () => {
  it("solo trae eventos scoped a esa opp", async () => {
    fake.setTable("opportunity_stage_history", [
      {
        id: "h-1",
        organization_id: ORG,
        opportunity_id: "opp-1",
        from_stage_id: null,
        to_stage_id: "stage-cot",
        changed_by_user_id: "u-1",
        context: "manual",
        changed_at: "2026-05-01T10:00:00.000Z",
      },
      // Esta es de otra opp — no debe aparecer.
      {
        id: "h-2",
        organization_id: ORG,
        opportunity_id: "opp-OTHER",
        from_stage_id: null,
        to_stage_id: "stage-cot",
        changed_by_user_id: "u-1",
        context: "manual",
        changed_at: "2026-05-02T10:00:00.000Z",
      },
    ]);
    fake.setTable("orders", [
      {
        id: "ord-1",
        organization_id: ORG,
        contact_id: "c-1",
        opportunity_id: "opp-1",
        shopify_order_id: "5001",
        shopify_name: "#5001",
        financial_status: "paid",
        total_amount: "1000.00",
        currency: "MXN",
        paid_at: "2026-05-05T10:00:00.000Z",
        cancelled_at: null,
        created_at: "2026-05-05T09:00:00.000Z",
      },
    ]);

    const events = await withTenantContext(ORG, async () => {
      return getOpportunityTimeline("opp-1");
    });

    const stageEvents = events.filter((e) => e.source === "stage_history");
    // Sólo el de opp-1 — el `.in("opportunity_id", ["opp-1"])` del
    // builder lo asegura.
    expect(stageEvents).toHaveLength(1);
    expect(stageEvents[0].meta).toMatchObject({
      to_stage_name: "Cotización",
    });

    const orderEvents = events.filter((e) => e.source === "orders");
    expect(orderEvents).toHaveLength(1);
    expect(orderEvents[0].kind).toBe("order_paid");
  });
});

describe("whitelist de audit_log", () => {
  it("eventos whitelisted entran al timeline", async () => {
    fake.setTable("opportunities", []);
    fake.setTable("audit_log", [
      {
        id: "a-1",
        organization_id: ORG,
        actor_user_id: "u-admin",
        event_type: "contact_reassigned",
        entity_type: "contact",
        entity_id: "c-1",
        payload: { from: "m-1", to: "m-2" },
        created_at: "2026-05-01T10:00:00.000Z",
      },
      {
        id: "a-2",
        organization_id: ORG,
        actor_user_id: "u-1",
        event_type: "contact_edited_manually",
        entity_type: "contact",
        entity_id: "c-1",
        payload: { fields: ["full_name", "phone"] },
        created_at: "2026-05-02T10:00:00.000Z",
      },
    ]);

    const events = await withTenantContext(ORG, async () => {
      return getContactTimeline("c-1");
    });

    const kinds = events.map((e) => e.kind).sort();
    expect(kinds).toContain("reassignment");
    expect(kinds).toContain("contact_edited");
  });

  it("eventos técnicos (sync_loop_prevented, *_intent_recorded) NO entran", async () => {
    fake.setTable("opportunities", []);
    fake.setTable("audit_log", [
      {
        id: "a-1",
        organization_id: ORG,
        actor_user_id: null,
        event_type: "sync_loop_prevented",
        entity_type: "contact",
        entity_id: "c-1",
        payload: { source: "shopify", reason: "own_echo_detected" },
        created_at: "2026-05-01T10:00:00.000Z",
      },
      {
        id: "a-2",
        organization_id: ORG,
        actor_user_id: null,
        event_type: "whaapy_sync_intent_recorded",
        entity_type: "contact",
        entity_id: "c-1",
        payload: {},
        created_at: "2026-05-02T10:00:00.000Z",
      },
    ]);

    const events = await withTenantContext(ORG, async () => {
      return getContactTimeline("c-1");
    });
    expect(events.filter((e) => e.source === "audit")).toHaveLength(0);
  });

  it("c2_opportunity_auto_created mapea a label específico por trigger", async () => {
    fake.setTable("opportunities", []);
    fake.setTable("audit_log", [
      {
        id: "a-1",
        organization_id: ORG,
        actor_user_id: null,
        event_type: "c2_opportunity_auto_created",
        entity_type: "contact",
        entity_id: "c-1",
        payload: { trigger: "new_contact_in_whaapy" },
        created_at: "2026-05-01T10:00:00.000Z",
      },
    ]);

    const events = await withTenantContext(ORG, async () => {
      return getContactTimeline("c-1");
    });
    expect(events[0].kind).toBe("opportunity_auto_created");
    expect(events[0].label).toMatch(/Lead nuevo en Whaapy/);
  });
});
