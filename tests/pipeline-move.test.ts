import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Cobertura del servicio `pipeline-move` (M5):
 *
 *  - Movimiento happy path emite UPDATE + audit + history.
 *  - Idempotente: mover a la misma etapa no genera mutaciones.
 *  - Stage destino que requiere motivo de pérdida sin proveerlo → error.
 *  - Stage destino en otro funnel → funnel_mismatch (sin mutaciones).
 *  - Stage inactiva → stage_inactive.
 *  - Opp cancelada → cancelled.
 *  - Opp inexistente → not_found.
 *  - Stale optimistic lock (BD devuelve 0 rows con PGRST116) →
 *    stale_version. La fila NO se sobrescribe.
 *  - Mover a etapa is_won marca won_at en la fila.
 *  - Mover a etapa is_lost incluye loss_reason_id en la fila.
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

import { withTenantContext } from "@/lib/tenant/context";
import { moveOpportunityStage } from "@/lib/services/pipeline-move";

const ORG = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-000000000010";

function seedStages() {
  fake.setTable("pipeline_stages", [
    {
      id: "stage-lead-nuevo",
      organization_id: ORG,
      funnel: "venta",
      name: "Lead nuevo",
      position: 1,
      is_active: true,
      is_initial: true,
      is_won: false,
      is_lost: false,
      requires_loss_reason: false,
    },
    {
      id: "stage-cotizacion",
      organization_id: ORG,
      funnel: "venta",
      name: "Cotización",
      position: 6,
      is_active: true,
      is_initial: false,
      is_won: false,
      is_lost: false,
      requires_loss_reason: false,
    },
    {
      id: "stage-ganada",
      organization_id: ORG,
      funnel: "venta",
      name: "Ganada",
      position: 8,
      is_active: true,
      is_initial: false,
      is_won: true,
      is_lost: false,
      requires_loss_reason: false,
    },
    {
      id: "stage-perdida",
      organization_id: ORG,
      funnel: "venta",
      name: "Perdida",
      position: 9,
      is_active: true,
      is_initial: false,
      is_won: false,
      is_lost: true,
      requires_loss_reason: true,
    },
    {
      id: "stage-inactiva",
      organization_id: ORG,
      funnel: "venta",
      name: "Eliminada",
      position: 10,
      is_active: false,
      is_initial: false,
      is_won: false,
      is_lost: false,
      requires_loss_reason: false,
    },
    {
      id: "stage-pv-pago",
      organization_id: ORG,
      funnel: "post_venta",
      name: "Pago confirmado",
      position: 1,
      is_active: true,
      is_initial: true,
      is_won: false,
      is_lost: false,
      requires_loss_reason: false,
    },
    {
      // M4v2: terminal de cierre normal de Post-venta (is_won → archiva
      // por el MISMO mecanismo que Ganada).
      id: "stage-pv-caso-cerrado",
      organization_id: ORG,
      funnel: "post_venta",
      name: "Caso cerrado",
      position: 6,
      is_active: true,
      is_initial: false,
      is_won: true,
      is_lost: false,
      requires_loss_reason: false,
    },
  ]);
}

function seedOpp(
  id: string,
  stageId: string,
  overrides: Record<string, unknown> = {},
) {
  fake.setTable("opportunities", [
    ...fake.getTable("opportunities"),
    {
      id,
      organization_id: ORG,
      funnel: "venta",
      stage_id: stageId,
      contact_id: "contact-1",
      assigned_advisor_id: "membership-1",
      parent_opportunity_id: null,
      shopify_draft_order_id: null,
      shopify_order_id: null,
      display_reference: null,
      actual_amount: null,
      estimated_amount: null,
      currency: "MXN",
      probability_override: null,
      weighted_amount: null,
      loss_reason_id: null,
      invoice_url: null,
      note: null,
      shipping_address: null,
      last_modified_at: "2026-05-01T10:00:00.000Z",
      last_modified_source: "shopify",
      created_at: "2026-04-01T10:00:00.000Z",
      updated_at: "2026-05-01T10:00:00.000Z",
      won_at: null,
      invoice_sent_at: null,
      cancelled_at: null,
      cancellation_source: null,
      cancellation_note: null,
      ...overrides,
    },
  ]);
}

function withTenant<T>(fn: () => Promise<T>): Promise<T> {
  return withTenantContext(ORG, async () => fn(), { source: "test" });
}

beforeEach(() => {
  fake.reset();
  seedStages();
});

describe("moveOpportunityStage", () => {
  it("happy path: mueve opp + escribe audit + escribe history", async () => {
    seedOpp("opp-1", "stage-lead-nuevo");
    const expected = "2026-05-01T10:00:00.000Z";

    const res = await withTenant(() =>
      moveOpportunityStage({
        opportunityId: "opp-1",
        toStageId: "stage-cotizacion",
        expectedLastModifiedAt: expected,
        actorUserId: USER,
        context: "manual",
      }),
    );

    expect(res.ok).toBe(true);
    const opps = fake.getTable("opportunities");
    expect(opps[0].stage_id).toBe("stage-cotizacion");
    expect(opps[0].last_modified_source).toBe("platform");

    const audit = fake.getTable("audit_log");
    expect(audit).toHaveLength(1);
    expect(audit[0].event_type).toBe("opportunity_stage_moved");
    expect(audit[0].entity_id).toBe("opp-1");

    const history = fake.getTable("opportunity_stage_history");
    expect(history).toHaveLength(1);
    expect(history[0].from_stage_id).toBe("stage-lead-nuevo");
    expect(history[0].to_stage_id).toBe("stage-cotizacion");
    expect(history[0].context).toBe("manual");
  });

  it("idempotencia: mover a la misma etapa no muta nada", async () => {
    seedOpp("opp-1", "stage-cotizacion");
    const res = await withTenant(() =>
      moveOpportunityStage({
        opportunityId: "opp-1",
        toStageId: "stage-cotizacion",
        expectedLastModifiedAt: "2026-05-01T10:00:00.000Z",
        actorUserId: USER,
        context: "manual",
      }),
    );
    expect(res.ok).toBe(true);
    expect(fake.getTable("audit_log")).toHaveLength(0);
    expect(fake.getTable("opportunity_stage_history")).toHaveLength(0);
  });

  it("etapa destino requiere motivo de pérdida sin proveerlo → loss_reason_required", async () => {
    seedOpp("opp-1", "stage-cotizacion");
    const res = await withTenant(() =>
      moveOpportunityStage({
        opportunityId: "opp-1",
        toStageId: "stage-perdida",
        expectedLastModifiedAt: "2026-05-01T10:00:00.000Z",
        actorUserId: USER,
        context: "manual",
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("loss_reason_required");
    expect(fake.getTable("audit_log")).toHaveLength(0);
    expect(fake.getTable("opportunity_stage_history")).toHaveLength(0);
  });

  it("etapa destino en otro funnel → funnel_mismatch", async () => {
    seedOpp("opp-1", "stage-cotizacion");
    const res = await withTenant(() =>
      moveOpportunityStage({
        opportunityId: "opp-1",
        toStageId: "stage-pv-pago",
        expectedLastModifiedAt: "2026-05-01T10:00:00.000Z",
        actorUserId: USER,
        context: "manual",
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("funnel_mismatch");
  });

  it("etapa destino inactiva → stage_inactive", async () => {
    seedOpp("opp-1", "stage-cotizacion");
    const res = await withTenant(() =>
      moveOpportunityStage({
        opportunityId: "opp-1",
        toStageId: "stage-inactiva",
        expectedLastModifiedAt: "2026-05-01T10:00:00.000Z",
        actorUserId: USER,
        context: "manual",
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("stage_inactive");
  });

  it("opp cancelada → cancelled (sin mutaciones)", async () => {
    seedOpp("opp-1", "stage-cotizacion", {
      cancelled_at: "2026-05-02T12:00:00.000Z",
      cancellation_source: "shopify_draft_deleted",
    });
    const res = await withTenant(() =>
      moveOpportunityStage({
        opportunityId: "opp-1",
        toStageId: "stage-ganada",
        expectedLastModifiedAt: "2026-05-01T10:00:00.000Z",
        actorUserId: USER,
        context: "manual",
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("cancelled");
    expect(fake.getTable("audit_log")).toHaveLength(0);
  });

  it("opp inexistente → not_found", async () => {
    const res = await withTenant(() =>
      moveOpportunityStage({
        opportunityId: "00000000-0000-0000-0000-0000000000ff",
        toStageId: "stage-ganada",
        expectedLastModifiedAt: "2026-05-01T10:00:00.000Z",
        actorUserId: USER,
        context: "manual",
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
  });

  it("mover a etapa Ganada por drag manual marca won_at", async () => {
    seedOpp("opp-1", "stage-cotizacion");
    const res = await withTenant(() =>
      moveOpportunityStage({
        opportunityId: "opp-1",
        toStageId: "stage-ganada",
        expectedLastModifiedAt: "2026-05-01T10:00:00.000Z",
        actorUserId: USER,
        context: "manual",
      }),
    );
    expect(res.ok).toBe(true);
    const opp = fake.getTable("opportunities")[0];
    expect(opp.stage_id).toBe("stage-ganada");
    expect(opp.won_at).toBeTruthy();
  });

  it("Post-venta → 'Caso cerrado' (is_won) marca won_at: archiva como Ganada", async () => {
    seedOpp("opp-pv", "stage-pv-pago", {
      funnel: "post_venta",
      parent_opportunity_id: "parent-1",
    });
    const res = await withTenant(() =>
      moveOpportunityStage({
        opportunityId: "opp-pv",
        toStageId: "stage-pv-caso-cerrado",
        expectedLastModifiedAt: "2026-05-01T10:00:00.000Z",
        actorUserId: USER,
        context: "manual",
      }),
    );
    expect(res.ok).toBe(true);
    const opp = fake.getTable("opportunities")[0];
    expect(opp.stage_id).toBe("stage-pv-caso-cerrado");
    // won_at poblado → entra al mismo auto-ocultar/"Ver cerradas" que Ganada.
    expect(opp.won_at).toBeTruthy();
  });

  it("mover a etapa Perdida con motivo escribe loss_reason_id", async () => {
    seedOpp("opp-1", "stage-cotizacion");
    const res = await withTenant(() =>
      moveOpportunityStage({
        opportunityId: "opp-1",
        toStageId: "stage-perdida",
        expectedLastModifiedAt: "2026-05-01T10:00:00.000Z",
        actorUserId: USER,
        context: "manual",
        lossReasonId: "loss-precio",
        note: "Cliente eligió competidor",
      }),
    );
    expect(res.ok).toBe(true);
    const opp = fake.getTable("opportunities")[0];
    expect(opp.stage_id).toBe("stage-perdida");
    expect(opp.loss_reason_id).toBe("loss-precio");
    expect(opp.note).toBe("Cliente eligió competidor");
  });

  it("stale_version cuando expectedLastModifiedAt no matchea", async () => {
    seedOpp("opp-1", "stage-cotizacion", {
      last_modified_at: "2026-05-02T13:00:00.000Z",
    });
    const res = await withTenant(() =>
      moveOpportunityStage({
        opportunityId: "opp-1",
        toStageId: "stage-ganada",
        // expected ≠ valor real en BD → 0 rows updated.
        expectedLastModifiedAt: "2026-05-01T10:00:00.000Z",
        actorUserId: USER,
        context: "manual",
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("stale_version");
    expect(fake.getTable("audit_log")).toHaveLength(0);
    expect(fake.getTable("opportunity_stage_history")).toHaveLength(0);
    // La fila NO debe haber sido movida.
    expect(fake.getTable("opportunities")[0].stage_id).toBe("stage-cotizacion");
  });
});
