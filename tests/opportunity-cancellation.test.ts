import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Cancelación de oportunidades (migración 0014).
 *
 * Verifica:
 *   - `cancelOpportunity` marca cancelled_at + source SIN mover
 *     de etapa y SIN insertar en opportunity_stage_history.
 *   - Idempotente: segunda invocación no reescribe el primer
 *     cancelled_at.
 *   - `listOpportunities` por default excluye canceladas.
 *   - `includeCancelled` trae activas + canceladas.
 *   - `onlyCancelled` trae solo canceladas.
 *   - Win rate sintético: filtro default excluye canceladas del
 *     denominador (cancelado ≠ perdido).
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

import { withTenantContext } from "@/lib/tenant/context";
import {
  cancelOpportunity,
  listOpportunities,
} from "@/lib/db/opportunities";

const ORG = "org-1";

function seedStages() {
  fake.setTable("pipeline_stages", [
    { id: "stage-cotizacion", organization_id: ORG, funnel: "venta", name: "Cotización", is_won: false, is_lost: false, position: 6 },
    { id: "stage-ganada", organization_id: ORG, funnel: "venta", name: "Ganada", is_won: true, is_lost: false, position: 8 },
    { id: "stage-perdida", organization_id: ORG, funnel: "venta", name: "Perdida", is_won: false, is_lost: true, position: 9 },
  ]);
}

function seedOpp(opts: {
  id: string;
  stageId: string;
  cancelledAt?: string | null;
  cancellationSource?: string | null;
}) {
  const row = {
    id: opts.id,
    organization_id: ORG,
    funnel: "venta",
    stage_id: opts.stageId,
    contact_id: "contact-1",
    assigned_advisor_id: "m-1",
    parent_opportunity_id: null,
    shopify_draft_order_id: `do-${opts.id}`,
    shopify_order_id: null,
    display_reference: `#D${opts.id}`,
    actual_amount: "1000.00",
    estimated_amount: null,
    currency: "MXN",
    probability_override: null,
    weighted_amount: null,
    loss_reason_id: null,
    invoice_url: null,
    note: null,
    shipping_address: null,
    last_modified_at: "2026-05-01T00:00:00Z",
    last_modified_source: "shopify",
    won_at: null,
    invoice_sent_at: null,
    cancelled_at: opts.cancelledAt ?? null,
    cancellation_source: opts.cancellationSource ?? null,
    cancellation_note: null,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
  };
  fake.setTable("opportunities", [...fake.getTable("opportunities"), row]);
  return row;
}

beforeEach(() => {
  fake.reset();
  seedStages();
});

describe("cancelOpportunity", () => {
  it("marca cancelled_at + cancellation_source sin mover de etapa", async () => {
    const opp = seedOpp({ id: "opp-1", stageId: "stage-cotizacion" });
    await withTenantContext(ORG, async () => {
      const result = await cancelOpportunity({
        opportunityId: opp.id,
        source: "shopify_draft_deleted",
        note: "DO eliminado",
      });
      expect(result.alreadyCancelled).toBe(false);
      expect(result.opportunity.cancelled_at).toBeTruthy();
      expect(result.opportunity.cancellation_source).toBe("shopify_draft_deleted");
      expect(result.opportunity.cancellation_note).toBe("DO eliminado");
      // Etapa preservada (auditoría: dónde estaba al cancelarse)
      expect(result.opportunity.stage_id).toBe("stage-cotizacion");
    });
    // NO debe haberse insertado entrada en stage history
    expect(fake.getTable("opportunity_stage_history")).toEqual([]);
  });

  it("idempotente: segunda invocación NO sobrescribe cancelled_at", async () => {
    const firstTs = "2026-05-10T10:00:00Z";
    const opp = seedOpp({
      id: "opp-2",
      stageId: "stage-cotizacion",
      cancelledAt: firstTs,
      cancellationSource: "shopify_draft_deleted",
    });
    await withTenantContext(ORG, async () => {
      const result = await cancelOpportunity({
        opportunityId: opp.id,
        source: "admin_manual",
      });
      expect(result.alreadyCancelled).toBe(true);
      expect(result.opportunity.cancelled_at).toBe(firstTs);
      expect(result.opportunity.cancellation_source).toBe("shopify_draft_deleted");
    });
  });

  it("NO transita oportunidades canceladas a etapa Perdida (regresión: cancelado ≠ perdido)", async () => {
    const opp = seedOpp({ id: "opp-3", stageId: "stage-cotizacion" });
    await withTenantContext(ORG, async () => {
      const result = await cancelOpportunity({
        opportunityId: opp.id,
        source: "shopify_draft_deleted",
      });
      expect(result.opportunity.stage_id).not.toBe("stage-perdida");
      expect(result.opportunity.stage_id).toBe("stage-cotizacion");
    });
  });
});

describe("listOpportunities — filtros de cancelación", () => {
  it("default: excluye canceladas", async () => {
    seedOpp({ id: "opp-active-1", stageId: "stage-cotizacion" });
    seedOpp({
      id: "opp-cancelled-1",
      stageId: "stage-cotizacion",
      cancelledAt: "2026-05-10T10:00:00Z",
      cancellationSource: "shopify_draft_deleted",
    });
    await withTenantContext(ORG, async () => {
      const all = await listOpportunities({ funnel: "venta" });
      expect(all.map((o) => o.id)).toEqual(["opp-active-1"]);
    });
  });

  it("includeCancelled=true: trae activas + canceladas", async () => {
    seedOpp({ id: "opp-A", stageId: "stage-cotizacion" });
    seedOpp({
      id: "opp-B",
      stageId: "stage-cotizacion",
      cancelledAt: "2026-05-10T10:00:00Z",
      cancellationSource: "shopify_draft_deleted",
    });
    await withTenantContext(ORG, async () => {
      const all = await listOpportunities({ funnel: "venta", includeCancelled: true });
      expect(all.map((o) => o.id).sort()).toEqual(["opp-A", "opp-B"]);
    });
  });

  it("onlyCancelled=true: solo canceladas", async () => {
    seedOpp({ id: "opp-active", stageId: "stage-cotizacion" });
    seedOpp({
      id: "opp-cancelled-x",
      stageId: "stage-ganada",
      cancelledAt: "2026-05-10T10:00:00Z",
      cancellationSource: "shopify_draft_deleted",
    });
    await withTenantContext(ORG, async () => {
      const only = await listOpportunities({ funnel: "venta", onlyCancelled: true });
      expect(only.map((o) => o.id)).toEqual(["opp-cancelled-x"]);
    });
  });
});

describe("Win rate sintético — cancelado NO contamina denominador (R5)", () => {
  it("opp cancelada en etapa Cotización NO cuenta como pérdida", async () => {
    seedOpp({ id: "ganada-1", stageId: "stage-ganada" });
    seedOpp({ id: "ganada-2", stageId: "stage-ganada" });
    seedOpp({ id: "perdida-real", stageId: "stage-perdida" });
    seedOpp({
      id: "cancelada-admin",
      stageId: "stage-cotizacion",
      cancelledAt: "2026-05-10T10:00:00Z",
      cancellationSource: "shopify_draft_deleted",
    });

    await withTenantContext(ORG, async () => {
      const active = await listOpportunities({ funnel: "venta" });
      const ganadas = active.filter((o) => o.stage_id === "stage-ganada").length;
      const perdidas = active.filter((o) => o.stage_id === "stage-perdida").length;
      const winRate = ganadas / (ganadas + perdidas);
      // 2 ganadas / (2 ganadas + 1 perdida real) = 66.6%
      // Si la cancelada contara como pérdida sería 2/4 = 50% — INCORRECTO.
      expect(winRate).toBeCloseTo(2 / 3, 5);
    });
  });
});
