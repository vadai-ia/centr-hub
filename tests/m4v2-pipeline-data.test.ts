import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * M4v2 data layer:
 *  - Bucketing de "Ver cerradas" con retención 30d (visible / revelable /
 *    expirada) en countKanbanOpportunitiesByStage (tests diferidos del
 *    Bloque C).
 *  - searchOpportunitiesAnyState: transversal (cualquier estado) + scope
 *    por asesor.
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

import { withTenantContext } from "@/lib/tenant/context";
import {
  countKanbanOpportunitiesByStage,
  searchOpportunitiesAnyState,
} from "@/lib/db/opportunities";

const ORG = "org-1";
const WON = "won-stage";

// Cortes explícitos (comparación lexicográfica ISO UTC, sin luxon):
const CUTOFF_7D = "2026-06-15T00:00:00.000Z"; // auto-ocultar
const RETENTION_30D = "2026-05-23T00:00:00.000Z"; // retención lista

const run = <T>(fn: () => Promise<T>) =>
  withTenantContext(ORG, fn, { source: "worker" });

beforeEach(() => {
  fake.reset();
});

describe("countKanbanOpportunitiesByStage — bucketing retención 30d (M4v2)", () => {
  function seedClosed() {
    const base = {
      organization_id: ORG,
      funnel: "post_venta",
      stage_id: WON,
      cancelled_at: null,
      resolved_at: null,
      lost_at: null,
    };
    fake.setTable("opportunities", [
      { ...base, id: "recent", won_at: "2026-06-20T00:00:00.000Z" }, // >= cutoff → visible
      { ...base, id: "null-date", won_at: null }, // NULL → visible
      { ...base, id: "revealable", won_at: "2026-06-01T00:00:00.000Z" }, // [30d,7d) → hidden
      { ...base, id: "expired", won_at: "2026-05-01T00:00:00.000Z" }, // < 30d → expirada
    ]);
  }

  it("parte en visible / revelable(hidden) / expirada según los dos cortes", async () => {
    seedClosed();
    const res = await run(() =>
      countKanbanOpportunitiesByStage({
        funnel: "post_venta",
        closedHide: {
          cutoffIso: CUTOFF_7D,
          retentionCutoffIso: RETENTION_30D,
          wonStageIds: [WON],
          lostStageIds: [],
        },
      }),
    );
    // Visible: recent + null-date = 2.
    expect(res.counts[WON]).toBe(2);
    // Revelable en "Ver cerradas": revealable = 1 (la expirada NO cuenta).
    expect(res.hiddenCounts[WON]).toBe(1);
  });

  it("sin retención (back-compat): toda cerrada-antes-de-cutoff cuenta como oculta", async () => {
    seedClosed();
    const res = await run(() =>
      countKanbanOpportunitiesByStage({
        funnel: "post_venta",
        closedHide: {
          cutoffIso: CUTOFF_7D,
          wonStageIds: [WON],
          lostStageIds: [],
        },
      }),
    );
    // Visible: 2 (recent + null). Oculta: revealable + expired = 2.
    expect(res.counts[WON]).toBe(2);
    expect(res.hiddenCounts[WON]).toBe(2);
  });
});

describe("searchOpportunitiesAnyState — transversal + scope por asesor (M4v2)", () => {
  function seed() {
    fake.setTable("contacts", [
      { id: "c-1", organization_id: ORG, full_name: "Cliente Uno", phone: "+521", email: null },
    ]);
    const base = {
      organization_id: ORG,
      contact_id: "c-1",
      stage_id: "s-1",
      last_modified_at: "2026-06-01T00:00:00Z",
      won_at: null,
      lost_at: null,
      cancelled_at: null,
      resolved_at: null,
      reopened_at: null,
      display_reference: null,
      shopify_order_id: null,
    };
    fake.setTable("opportunities", [
      { ...base, id: "o-won", funnel: "venta", won_at: "2026-04-01T00:00:00Z", assigned_advisor_id: "adv-1" },
      { ...base, id: "o-lost", funnel: "venta", lost_at: "2026-04-02T00:00:00Z", assigned_advisor_id: "adv-1" },
      { ...base, id: "o-cancel", funnel: "venta", cancelled_at: "2026-04-03T00:00:00Z", assigned_advisor_id: "adv-2" },
      { ...base, id: "o-resolved", funnel: "post_venta", resolved_at: "2026-04-04T00:00:00Z", assigned_advisor_id: "adv-2" },
      { ...base, id: "o-active", funnel: "post_venta", assigned_advisor_id: "adv-1" },
    ]);
  }

  it("admin (sin scope) encuentra opps en CUALQUIER estado", async () => {
    seed();
    const rows = await run(() =>
      searchOpportunitiesAnyState({ query: "Cliente", limit: 25 }),
    );
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(
      ["o-active", "o-cancel", "o-lost", "o-resolved", "o-won"].sort(),
    );
  });

  it("vendedor: solo sus propias opps (scope por assigned_advisor_id)", async () => {
    seed();
    const rows = await run(() =>
      searchOpportunitiesAnyState({
        query: "Cliente",
        assignedAdvisorId: "adv-1",
        limit: 25,
      }),
    );
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["o-active", "o-lost", "o-won"].sort());
  });
});
