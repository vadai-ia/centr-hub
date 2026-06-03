import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Absorción de "Lead nuevo" (M3 hotfix — race R12 ↔ Cotización).
 *
 * Cubre la dirección de race inversa a la que R12 ya cubría: cuando
 * R12 alcanzó a crear el Lead nuevo ANTES de que el webhook
 * `draft_orders/create` aterrizara la Cotización, el Lead nuevo se
 * absorbe (cancela como `absorbed_by_advanced_opportunity`).
 *
 * Garantiza:
 *   - El Lead nuevo se cancela (NO se borra) — no contamina win rate.
 *   - Se respeta la opp absorbente (Cotización): jamás se cancela a
 *     sí misma aunque estuviera en etapa inicial (defensa edge case).
 *   - No-op cuando no hay Lead nuevo activo.
 *   - Audit log explícito con opp absorbente + absorbida + contacto.
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

import { withTenantContext } from "@/lib/tenant/context";
import { absorbInitialStageOpportunities } from "@/lib/services/opportunity-absorption";

const ORG = "org-1";
const CONTACT = "contact-1";
const LEAD_NUEVO_STAGE = "stage-lead-nuevo";
const CONTACTADO_STAGE = "stage-contactado";
const COTIZACION_STAGE = "stage-cotizacion";

function seedStages() {
  fake.setTable("pipeline_stages", [
    {
      id: LEAD_NUEVO_STAGE,
      organization_id: ORG,
      funnel: "venta",
      name: "Lead nuevo",
      is_initial: true,
      is_won: false,
      is_lost: false,
      position: 1,
    },
    {
      id: CONTACTADO_STAGE,
      organization_id: ORG,
      funnel: "venta",
      name: "Contactado asesor",
      is_initial: false,
      is_won: false,
      is_lost: false,
      position: 2,
    },
    {
      id: COTIZACION_STAGE,
      organization_id: ORG,
      funnel: "venta",
      name: "Cotización",
      is_initial: false,
      is_won: false,
      is_lost: false,
      position: 6,
    },
  ]);
}

function seedOpp(opts: {
  id: string;
  stageId: string;
  contactId?: string;
  cancelledAt?: string | null;
  draftOrderId?: string | null;
}) {
  const row = {
    id: opts.id,
    organization_id: ORG,
    funnel: "venta",
    stage_id: opts.stageId,
    contact_id: opts.contactId ?? CONTACT,
    assigned_advisor_id: null,
    parent_opportunity_id: null,
    shopify_draft_order_id: opts.draftOrderId ?? null,
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
    last_modified_at: "2026-05-01T00:00:00Z",
    last_modified_source: "platform",
    won_at: null,
    invoice_sent_at: null,
    cancelled_at: opts.cancelledAt ?? null,
    cancellation_source: null,
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

describe("absorbInitialStageOpportunities", () => {
  it("cancela el Lead nuevo activo cuando llega una Cotización (race R12 antes que DO)", async () => {
    const lead = seedOpp({ id: "opp-lead", stageId: LEAD_NUEVO_STAGE });
    const cot = seedOpp({ id: "opp-cot", stageId: COTIZACION_STAGE });

    await withTenantContext(ORG, async () => {
      const result = await absorbInitialStageOpportunities({
        contactId: CONTACT,
        absorbingOpportunityId: cot.id,
        trigger: "draft_orders_create",
      });
      expect(result.absorbedOpportunityIds).toEqual([lead.id]);
    });

    const opps = fake.getTable("opportunities");
    const updatedLead = opps.find((o) => o.id === lead.id)!;
    const updatedCot = opps.find((o) => o.id === cot.id)!;

    // Lead nuevo cancelado con source semántica
    expect(updatedLead.cancelled_at).toBeTruthy();
    expect(updatedLead.cancellation_source).toBe("absorbed_by_advanced_opportunity");
    // Etapa preservada (auditoría)
    expect(updatedLead.stage_id).toBe(LEAD_NUEVO_STAGE);
    // Cotización NO se toca
    expect(updatedCot.cancelled_at).toBeNull();
    expect(updatedCot.stage_id).toBe(COTIZACION_STAGE);

    // Audit log con metadata completa
    const audit = fake.getTable("audit_log");
    const entry = audit.find(
      (a) => a.event_type === "lead_nuevo_absorbed_by_advanced_opportunity",
    );
    expect(entry).toBeDefined();
    expect((entry!.payload as Record<string, unknown>).absorbing_opportunity_id).toBe(cot.id);
    expect((entry!.payload as Record<string, unknown>).absorbed_opportunity_id).toBe(lead.id);
    expect((entry!.payload as Record<string, unknown>).contact_id).toBe(CONTACT);
  });

  it("no-op cuando el contacto no tiene Lead nuevo activo", async () => {
    const cot = seedOpp({ id: "opp-cot", stageId: COTIZACION_STAGE });

    await withTenantContext(ORG, async () => {
      const result = await absorbInitialStageOpportunities({
        contactId: CONTACT,
        absorbingOpportunityId: cot.id,
        trigger: "draft_orders_create",
      });
      expect(result.absorbedOpportunityIds).toEqual([]);
    });

    const audit = fake.getTable("audit_log");
    expect(
      audit.some((a) => a.event_type === "lead_nuevo_absorbed_by_advanced_opportunity"),
    ).toBe(false);
  });

  it("NO cancela Lead nuevo ya cancelado previamente (idempotencia)", async () => {
    seedOpp({
      id: "opp-lead-cancelled",
      stageId: LEAD_NUEVO_STAGE,
      cancelledAt: "2026-05-09T10:00:00Z",
    });
    const cot = seedOpp({ id: "opp-cot", stageId: COTIZACION_STAGE });

    await withTenantContext(ORG, async () => {
      const result = await absorbInitialStageOpportunities({
        contactId: CONTACT,
        absorbingOpportunityId: cot.id,
        trigger: "draft_orders_create",
      });
      // listOpportunities default excluye canceladas → no candidato
      expect(result.absorbedOpportunityIds).toEqual([]);
    });
  });

  it("ignora Lead nuevo de OTRO contacto", async () => {
    seedOpp({ id: "opp-lead-other", stageId: LEAD_NUEVO_STAGE, contactId: "contact-other" });
    const cot = seedOpp({ id: "opp-cot", stageId: COTIZACION_STAGE });

    await withTenantContext(ORG, async () => {
      const result = await absorbInitialStageOpportunities({
        contactId: CONTACT,
        absorbingOpportunityId: cot.id,
        trigger: "draft_orders_create",
      });
      expect(result.absorbedOpportunityIds).toEqual([]);
    });

    // El Lead nuevo de otro contacto sigue activo intacto
    const other = fake
      .getTable("opportunities")
      .find((o) => o.id === "opp-lead-other")!;
    expect(other.cancelled_at).toBeNull();
  });

  it("absorbe un lead en etapa intermedia pre-Cotización (no solo 'Lead nuevo') — fix M7.2 #4", async () => {
    const lead = seedOpp({ id: "opp-contactado", stageId: CONTACTADO_STAGE });
    const cot = seedOpp({ id: "opp-cot", stageId: COTIZACION_STAGE });

    await withTenantContext(ORG, async () => {
      const result = await absorbInitialStageOpportunities({
        contactId: CONTACT,
        absorbingOpportunityId: cot.id,
        trigger: "draft_orders_create",
      });
      expect(result.absorbedOpportunityIds).toEqual([lead.id]);
    });

    const updatedLead = fake.getTable("opportunities").find((o) => o.id === lead.id)!;
    expect(updatedLead.cancelled_at).toBeTruthy();
    expect(updatedLead.cancellation_source).toBe("absorbed_by_advanced_opportunity");
    expect(updatedLead.stage_id).toBe(CONTACTADO_STAGE);
  });

  it("NO absorbe una opp pre-Cotización que YA tiene su propia draft ligada (coexisten) — fix M7.2 #4", async () => {
    const withDraft = seedOpp({
      id: "opp-contactado-draft",
      stageId: CONTACTADO_STAGE,
      draftOrderId: "999000111",
    });
    const cot = seedOpp({ id: "opp-cot", stageId: COTIZACION_STAGE });

    await withTenantContext(ORG, async () => {
      const result = await absorbInitialStageOpportunities({
        contactId: CONTACT,
        absorbingOpportunityId: cot.id,
        trigger: "draft_orders_create",
      });
      expect(result.absorbedOpportunityIds).toEqual([]);
    });

    const after = fake.getTable("opportunities").find((o) => o.id === withDraft.id)!;
    expect(after.cancelled_at).toBeNull();
  });

  it("nunca cancela la opp absorbente aunque estuviera en etapa inicial (defensa edge)", async () => {
    // Edge defensivo: admin reasignó Cotización a etapa "Lead nuevo".
    // Aunque es inválido operativamente, el absorber NO se canibaliza.
    const cot = seedOpp({ id: "opp-cot", stageId: LEAD_NUEVO_STAGE });

    await withTenantContext(ORG, async () => {
      const result = await absorbInitialStageOpportunities({
        contactId: CONTACT,
        absorbingOpportunityId: cot.id,
        trigger: "draft_orders_create",
      });
      expect(result.absorbedOpportunityIds).toEqual([]);
    });

    const cotAfter = fake.getTable("opportunities").find((o) => o.id === cot.id)!;
    expect(cotAfter.cancelled_at).toBeNull();
  });
});
