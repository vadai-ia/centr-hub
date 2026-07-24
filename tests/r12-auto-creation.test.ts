import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * R12 auto-creación C2 (M4) — pre-condiciones y supresión.
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

import { withTenantContext } from "@/lib/tenant/context";
import { evaluateAndCreateC2Opportunity } from "@/lib/services/r12-auto-creation";
import type { ContactRow, Json } from "@/lib/types/database";

const ORG = "org-1";
const INITIAL_STAGE = "stage-lead-nuevo";

function makeContact(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: "contact-1",
    organization_id: ORG,
    full_name: "Lead Test",
    email: "lead@example.com",
    phone: "+525500000000",
    address: null,
    internal_note: null,
    shopify_tags: [],
    shopify_state: null,
    assigned_advisor_id: "membership-1",
    shopify_customer_id: null,
    whaapy_contact_id: "wh-1",
    field_metadata: {} as Json,
    last_modified_at: "2026-05-01T00:00:00Z",
    last_modified_source: "whaapy",
    missing_phone: false,
    deleted_in_shopify: false,
    deleted_in_whaapy: false,
    anonymized_at: null,
    last_whaapy_activity_at: null,
    is_outbound: false,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

function seedOrg(opts: { backfill?: boolean; thresholdDays?: number } = {}) {
  fake.setTable("organizations", [
    {
      id: ORG,
      name: "Test Org",
      slug: "test",
      backfill_in_progress: opts.backfill ?? false,
      c2_reactivity_threshold_days: opts.thresholdDays ?? 30,
    },
  ]);
  fake.setTable("pipeline_stages", [
    {
      id: INITIAL_STAGE,
      organization_id: ORG,
      funnel: "venta",
      name: "Lead nuevo",
      is_initial: true,
      is_won: false,
      is_lost: false,
    },
  ]);
}

beforeEach(() => {
  fake.reset();
  seedOrg();
});

describe("R12 — auto-creación C2", () => {
  it("crea oportunidad en Lead nuevo con asesor heredado (disparador new_contact_in_whaapy)", async () => {
    const contact = makeContact();
    await withTenantContext(ORG, async () => {
      const result = await evaluateAndCreateC2Opportunity({
        contact,
        trigger: "new_contact_in_whaapy",
        triggeredByEvent: "contact.created",
        previousActivityAt: null,
        currentActivityAt: "2026-05-15T10:00:00Z",
      });
      expect(result.created).toBe(true);
      expect(result.opportunityId).toBeDefined();
    });
    const opps = fake.getTable("opportunities");
    expect(opps).toHaveLength(1);
    expect(opps[0].contact_id).toBe(contact.id);
    expect(opps[0].assigned_advisor_id).toBe("membership-1");
    expect(opps[0].stage_id).toBe(INITIAL_STAGE);
    const audit = fake.getTable("audit_log");
    expect(audit.some((a) => a.event_type === "c2_opportunity_auto_created")).toBe(true);
  });

  it("NO crea durante backfill_in_progress", async () => {
    seedOrg({ backfill: true });
    const contact = makeContact();
    await withTenantContext(ORG, async () => {
      const result = await evaluateAndCreateC2Opportunity({
        contact,
        trigger: "new_contact_in_whaapy",
        triggeredByEvent: "contact.created",
        previousActivityAt: null,
        currentActivityAt: "2026-05-15T10:00:00Z",
      });
      expect(result.created).toBe(false);
      expect(result.skipReason).toBe("backfill_in_progress");
    });
    expect(fake.getTable("opportunities")).toHaveLength(0);
    const audit = fake.getTable("audit_log");
    expect(
      audit.some(
        (a) =>
          a.event_type === "c2_evaluation_skipped" &&
          (a.payload as { reason: string }).reason === "backfill_in_progress",
      ),
    ).toBe(true);
  });

  it("NO crea si el contact ya tiene oportunidad activa en Funnel Venta", async () => {
    const contact = makeContact();
    fake.setTable("opportunities", [
      {
        id: "opp-existing",
        organization_id: ORG,
        contact_id: contact.id,
        funnel: "venta",
        stage_id: INITIAL_STAGE,
        cancelled_at: null,
      },
    ]);
    await withTenantContext(ORG, async () => {
      const result = await evaluateAndCreateC2Opportunity({
        contact,
        trigger: "new_contact_in_whaapy",
        triggeredByEvent: "contact.created",
        previousActivityAt: null,
        currentActivityAt: "2026-05-15T10:00:00Z",
      });
      expect(result.created).toBe(false);
      expect(result.skipReason).toBe("active_opportunity_exists");
    });
    // No se creó otra
    expect(fake.getTable("opportunities")).toHaveLength(1);
  });

  it("disparador reactivity_after_n_days respeta threshold (no dispara dentro del umbral)", async () => {
    const contact = makeContact();
    // Actividad previa hace 10 días, threshold 30 → no dispara
    const previous = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    await withTenantContext(ORG, async () => {
      const result = await evaluateAndCreateC2Opportunity({
        contact,
        trigger: "reactivity_after_n_days",
        triggeredByEvent: "conversation.created",
        previousActivityAt: previous,
        currentActivityAt: now,
      });
      expect(result.created).toBe(false);
      expect(result.skipReason).toBe("reactivity_threshold_not_met");
    });
    expect(fake.getTable("opportunities")).toHaveLength(0);
  });

  it("disparador reactivity_after_n_days SÍ crea cuando el umbral se cumple", async () => {
    const contact = makeContact();
    // Actividad previa hace 60 días, threshold 30 → SÍ dispara
    const previous = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    await withTenantContext(ORG, async () => {
      const result = await evaluateAndCreateC2Opportunity({
        contact,
        trigger: "reactivity_after_n_days",
        triggeredByEvent: "conversation.created",
        previousActivityAt: previous,
        currentActivityAt: now,
      });
      expect(result.created).toBe(true);
    });
    expect(fake.getTable("opportunities")).toHaveLength(1);
  });

  it("falta etapa is_initial → skip con razón no_initial_stage", async () => {
    fake.setTable("pipeline_stages", [
      {
        id: "stage-x",
        organization_id: ORG,
        funnel: "venta",
        name: "X",
        is_initial: false,
      },
    ]);
    const contact = makeContact();
    await withTenantContext(ORG, async () => {
      const result = await evaluateAndCreateC2Opportunity({
        contact,
        trigger: "new_contact_in_whaapy",
        triggeredByEvent: "contact.created",
        previousActivityAt: null,
        currentActivityAt: new Date().toISOString(),
      });
      expect(result.created).toBe(false);
      expect(result.skipReason).toBe("no_initial_stage");
    });
  });
});
