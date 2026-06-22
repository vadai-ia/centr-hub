import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Reapertura híbrida hacia "Caso problemático" (M4v2, Bloque D).
 *   - Post-venta → muta en sitio (des-archiva).
 *   - Venta → reusa la hija Post-venta si existe; si no, crea una nueva.
 * Invariante: NUNCA toca assigned_advisor_id (R2/R5).
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

import { withTenantContext } from "@/lib/tenant/context";
import { reopenOpportunityIntoProblemCase } from "@/lib/services/opportunity-reopen";

const ORG = "org-1";
const ACTOR = "user-admin-1";
const PROBLEMATICO = "pv-7-caso-problematico";
const CASO_CERRADO = "pv-6-caso-cerrado";

function seedStages() {
  const def = (id: string, name: string, position: number, isWon = false) => ({
    id,
    organization_id: ORG,
    funnel: "post_venta",
    name,
    position,
    is_initial: position === 1,
    is_won: isWon,
    is_lost: false,
    is_active: true,
  });
  fake.setTable("pipeline_stages", [
    def("pv-1", "Cotización completada", 1),
    def("pv-2", "Pago confirmado", 2),
    def("pv-3", "Envío en curso", 3),
    def("pv-4", "Entregado", 4),
    def("pv-5", "Seguimiento post-entrega", 5),
    def(CASO_CERRADO, "Caso cerrado", 6, true),
    def(PROBLEMATICO, "Caso problemático", 7),
  ]);
}

function baseOpp(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "opp-x",
    organization_id: ORG,
    funnel: "post_venta",
    stage_id: CASO_CERRADO,
    contact_id: "contact-1",
    assigned_advisor_id: "advisor-9",
    parent_opportunity_id: null,
    shopify_draft_order_id: null,
    shopify_order_id: null,
    display_reference: null,
    actual_amount: null,
    estimated_amount: null,
    currency: "MXN",
    last_modified_at: "2026-06-01T00:00:00Z",
    last_modified_source: "platform",
    won_at: null,
    lost_at: null,
    cancelled_at: null,
    cancellation_source: null,
    cancellation_note: null,
    resolved_at: null,
    resolved_by_user_id: null,
    resolution_note: null,
    reopened_at: null,
    ...overrides,
  };
}

const rowsOf = () => fake.getTable("opportunities");
const byId = (id: string) => rowsOf().find((r) => r.id === id) as Record<string, unknown>;
const run = <T>(fn: () => Promise<T>) =>
  withTenantContext(ORG, fn, { source: "worker" });

beforeEach(() => {
  fake.reset();
  seedStages();
});

describe("reopenOpportunityIntoProblemCase — Post-venta (mutación en sitio)", () => {
  it("Caso cerrado (archivado) → Caso problemático, des-archiva y preserva asesor", async () => {
    fake.setTable("opportunities", [
      baseOpp({
        id: "opp-1",
        stage_id: CASO_CERRADO,
        won_at: "2026-05-01T00:00:00Z",
      }),
    ]);

    const res = await run(() =>
      reopenOpportunityIntoProblemCase({ opportunityId: "opp-1", actorUserId: ACTOR }),
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.mode).toBe("mutated");
      expect(res.opportunityId).toBe("opp-1");
    }
    const opp = byId("opp-1");
    expect(opp.stage_id).toBe(PROBLEMATICO);
    expect(opp.won_at).toBeNull();
    expect(opp.reopened_at).not.toBeNull();
    expect(opp.assigned_advisor_id).toBe("advisor-9"); // R2/R5 intacto
    // Historial: hubo cambio de etapa → una entrada.
    expect(fake.getTable("opportunity_stage_history").length).toBe(1);
  });

  it("caso resuelto en Caso problemático → limpia resolved_*, etapa NO cambia, sin history", async () => {
    fake.setTable("opportunities", [
      baseOpp({
        id: "opp-2",
        stage_id: PROBLEMATICO,
        resolved_at: "2026-05-10T00:00:00Z",
        resolved_by_user_id: "user-9",
        resolution_note: "reembolso",
      }),
    ]);

    const res = await run(() =>
      reopenOpportunityIntoProblemCase({ opportunityId: "opp-2", actorUserId: ACTOR }),
    );

    expect(res.ok && res.mode).toBe("mutated");
    const opp = byId("opp-2");
    expect(opp.stage_id).toBe(PROBLEMATICO);
    expect(opp.resolved_at).toBeNull();
    expect(opp.resolved_by_user_id).toBeNull();
    expect(opp.reopened_at).not.toBeNull();
    // Etapa no cambió → no se inserta history (inmutable, sin ruido).
    expect(fake.getTable("opportunity_stage_history").length).toBe(0);
  });
});

describe("reopenOpportunityIntoProblemCase — Venta (cruce de funnel)", () => {
  it("Venta SIN hija → crea hija Post-venta enlazada, deja la Venta intacta", async () => {
    fake.setTable("opportunities", [
      baseOpp({
        id: "opp-venta",
        funnel: "venta",
        stage_id: "venta-ganada",
        won_at: "2026-04-01T00:00:00Z",
        shopify_order_id: "SO-77",
        shopify_draft_order_id: "DO-77",
        display_reference: "#D77",
        actual_amount: "1000.00",
        assigned_advisor_id: "advisor-5",
      }),
    ]);

    const res = await run(() =>
      reopenOpportunityIntoProblemCase({ opportunityId: "opp-venta", actorUserId: ACTOR }),
    );

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.mode).toBe("created_child");

    // La Venta queda intacta.
    const venta = byId("opp-venta");
    expect(venta.funnel).toBe("venta");
    expect(venta.won_at).toBe("2026-04-01T00:00:00Z");
    expect(venta.stage_id).toBe("venta-ganada");

    // La hija nueva: post_venta, en Caso problemático, enlazada, asesor heredado.
    const child = rowsOf().find((r) => r.id !== "opp-venta") as Record<string, unknown>;
    expect(child).toBeTruthy();
    expect(child.funnel).toBe("post_venta");
    expect(child.stage_id).toBe(PROBLEMATICO);
    expect(child.parent_opportunity_id).toBe("opp-venta");
    expect(child.assigned_advisor_id).toBe("advisor-5"); // heredado, no reasignado
    expect(child.reopened_at).not.toBeNull();
    // NO hereda shopify_draft_order_id (unique constraint, 0021).
    expect(child.shopify_draft_order_id).toBeNull();
    expect(child.shopify_order_id).toBe("SO-77");
  });

  it("Venta CON hija Post-venta existente → reabre la hija, no duplica", async () => {
    fake.setTable("opportunities", [
      baseOpp({
        id: "opp-venta",
        funnel: "venta",
        stage_id: "venta-ganada",
        won_at: "2026-04-01T00:00:00Z",
        assigned_advisor_id: "advisor-5",
      }),
      baseOpp({
        id: "opp-child",
        funnel: "post_venta",
        parent_opportunity_id: "opp-venta",
        stage_id: CASO_CERRADO,
        won_at: "2026-05-01T00:00:00Z",
        assigned_advisor_id: "advisor-5",
      }),
    ]);

    const res = await run(() =>
      reopenOpportunityIntoProblemCase({ opportunityId: "opp-venta", actorUserId: ACTOR }),
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.mode).toBe("mutated");
      expect(res.opportunityId).toBe("opp-child");
    }
    // No se creó una hija nueva: siguen siendo 2 filas.
    expect(rowsOf().length).toBe(2);
    const child = byId("opp-child");
    expect(child.stage_id).toBe(PROBLEMATICO);
    expect(child.won_at).toBeNull();
    expect(child.reopened_at).not.toBeNull();
    // Venta intacta.
    expect(byId("opp-venta").won_at).toBe("2026-04-01T00:00:00Z");
  });
});

describe("reopenOpportunityIntoProblemCase — guardas", () => {
  it("opp inexistente → not_found", async () => {
    fake.setTable("opportunities", []);
    const res = await run(() =>
      reopenOpportunityIntoProblemCase({ opportunityId: "nope", actorUserId: ACTOR }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
  });
});
