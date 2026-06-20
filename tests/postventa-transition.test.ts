import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Driver del motor de transiciones de Post-venta (M3v2, Bloque B).
 *
 * Verifica la convivencia de reglas sobre datos en memoria:
 *  - AVANCE solo desde la zona automática (etapas 1-4).
 *  - PROBLEM-EXIT desde cualquier etapa activa (incluida una manual 5-6).
 *  - "Caso problemático" como sumidero (no avanza ni re-evalúa).
 *  - Idempotencia (no mueve si ya está en destino).
 *  - Atribución intacta tras el movimiento.
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

import { withTenantContext } from "@/lib/tenant/context";
import { applyPostventaTransition } from "@/lib/services/postventa-transition";

const ORG = "org-1";
const CONTACT = "contact-1";
const PARENT = "venta-parent-1";

const S = {
  cotizacion: "pv-1-cotizacion-completada",
  pago: "pv-2-pago-confirmado",
  envio: "pv-3-envio-en-curso",
  entregado: "pv-4-entregado",
  seguimiento: "pv-5-seguimiento",
  activo: "pv-6-cliente-activo",
  problematico: "pv-7-caso-problematico",
};

function seedStages() {
  const def = (id: string, name: string, position: number) => ({
    id,
    organization_id: ORG,
    funnel: "post_venta",
    name,
    position,
    color: "#000000",
    default_probability: null,
    is_initial: position === 1,
    is_won: false,
    is_lost: false,
    requires_loss_reason: false,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
  fake.setTable("pipeline_stages", [
    def(S.cotizacion, "Cotización completada", 1),
    def(S.pago, "Pago confirmado", 2),
    def(S.envio, "Envío en curso", 3),
    def(S.entregado, "Entregado", 4),
    def(S.seguimiento, "Seguimiento post-entrega", 5),
    def(S.activo, "Cliente activo", 6),
    def(S.problematico, "Caso problemático", 7),
  ]);
}

function seedOpp(overrides: Record<string, unknown> = {}) {
  fake.setTable("opportunities", [
    {
      id: "opp-1",
      organization_id: ORG,
      funnel: "post_venta",
      stage_id: S.cotizacion,
      contact_id: CONTACT,
      assigned_advisor_id: "advisor-9",
      parent_opportunity_id: PARENT,
      shopify_draft_order_id: null,
      shopify_order_id: "SO-100",
      cancelled_at: null,
      won_at: null,
      lost_at: null,
      loss_reason_id: null,
      note: null,
      last_modified_at: "2026-06-01T00:00:00Z",
      last_modified_source: "platform",
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
      ...overrides,
    },
  ]);
}

function seedOrder(financial: string, fulfillment: string | null, cancelledAt: string | null = null) {
  fake.setTable("orders", [
    {
      id: "order-1",
      organization_id: ORG,
      contact_id: CONTACT,
      assigned_advisor_id: "advisor-9",
      opportunity_id: PARENT,
      shopify_order_id: "SO-100",
      financial_status: financial,
      fulfillment_status: fulfillment,
      cancelled_at: cancelledAt,
      last_modified_at: "2026-06-10T00:00:00Z",
    },
  ]);
}

function currentStage(): string {
  return (fake.getTable("opportunities")[0] as { stage_id: string }).stage_id;
}
function currentAdvisor(): string | null {
  return (fake.getTable("opportunities")[0] as { assigned_advisor_id: string | null })
    .assigned_advisor_id;
}

beforeEach(() => {
  fake.reset();
  seedStages();
});

const run = <T>(fn: () => Promise<T>) => withTenantContext(ORG, fn, { source: "worker" });

describe("AVANCE dentro de la zona automática", () => {
  it("Cotización completada + pago pagado → Pago confirmado", async () => {
    seedOpp({ stage_id: S.cotizacion });
    seedOrder("paid", null);
    const r = await run(() => applyPostventaTransition("opp-1"));
    expect(r.status).toBe("moved");
    expect(currentStage()).toBe(S.pago);
  });

  it("precedencia: fulfilled gana → Entregado (aunque pago pendiente)", async () => {
    seedOpp({ stage_id: S.cotizacion });
    seedOrder("pending", "fulfilled");
    const r = await run(() => applyPostventaTransition("opp-1"));
    expect(r.status).toBe("moved");
    expect(currentStage()).toBe(S.entregado);
  });

  it("partial → Envío en curso", async () => {
    seedOpp({ stage_id: S.pago });
    seedOrder("paid", "partial");
    await run(() => applyPostventaTransition("opp-1"));
    expect(currentStage()).toBe(S.envio);
  });

  it("atribución intacta tras el movimiento", async () => {
    seedOpp({ stage_id: S.cotizacion, assigned_advisor_id: "advisor-9" });
    seedOrder("paid", null);
    await run(() => applyPostventaTransition("opp-1"));
    expect(currentAdvisor()).toBe("advisor-9");
  });
});

describe("AVANCE fuera de zona → no arrastra (handoff manual)", () => {
  it("opp en Seguimiento (pos 5) con pedido pagado → noop, no retrocede", async () => {
    seedOpp({ stage_id: S.seguimiento });
    seedOrder("paid", null);
    const r = await run(() => applyPostventaTransition("opp-1"));
    expect(r.status).toBe("noop");
    expect(r.reason).toBe("advance_out_of_zone");
    expect(currentStage()).toBe(S.seguimiento);
  });
});

describe("PROBLEM-EXIT → Caso problemático (one-way)", () => {
  it("reembolso desde la zona → Caso problemático", async () => {
    seedOpp({ stage_id: S.entregado });
    seedOrder("refunded", "fulfilled");
    const r = await run(() => applyPostventaTransition("opp-1"));
    expect(r.status).toBe("moved");
    expect(currentStage()).toBe(S.problematico);
  });

  it("cancelado desde etapa manual (pos 6) → Caso problemático", async () => {
    seedOpp({ stage_id: S.activo });
    seedOrder("paid", "fulfilled", "2026-06-15T00:00:00Z");
    const r = await run(() => applyPostventaTransition("opp-1"));
    expect(r.status).toBe("moved");
    expect(currentStage()).toBe(S.problematico);
  });

  it("partially_refunded → Caso problemático", async () => {
    seedOpp({ stage_id: S.pago });
    seedOrder("partially_refunded", null);
    await run(() => applyPostventaTransition("opp-1"));
    expect(currentStage()).toBe(S.problematico);
  });
});

describe("sumidero: Caso problemático no se toca", () => {
  it("opp ya en Caso problemático con pedido reembolsado → noop", async () => {
    seedOpp({ stage_id: S.problematico });
    seedOrder("refunded", null);
    const r = await run(() => applyPostventaTransition("opp-1"));
    expect(r.status).toBe("noop");
    expect(r.reason).toBe("already_problematic_sink");
    expect(currentStage()).toBe(S.problematico);
  });

  it("opp en Caso problemático con pedido pagado → no avanza", async () => {
    seedOpp({ stage_id: S.problematico });
    seedOrder("paid", "fulfilled");
    const r = await run(() => applyPostventaTransition("opp-1"));
    expect(r.status).toBe("noop");
    expect(currentStage()).toBe(S.problematico);
  });
});

describe("idempotencia y skips", () => {
  it("ya en la etapa destino → noop sin mover", async () => {
    seedOpp({ stage_id: S.pago });
    seedOrder("paid", null);
    const r = await run(() => applyPostventaTransition("opp-1"));
    expect(r.status).toBe("noop");
    expect(r.reason).toBe("already_in_target");
  });

  it("estado inesperado → noop (no_target), no mueve", async () => {
    seedOpp({ stage_id: S.cotizacion });
    seedOrder("authorized", null);
    const r = await run(() => applyPostventaTransition("opp-1"));
    expect(r.status).toBe("noop");
    expect(r.reason).toContain("no_target");
    expect(currentStage()).toBe(S.cotizacion);
  });

  it("opp sin shopify_order_id → skipped", async () => {
    seedOpp({ stage_id: S.cotizacion, shopify_order_id: null });
    seedOrder("paid", null);
    const r = await run(() => applyPostventaTransition("opp-1"));
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("no_shopify_order_id");
  });

  it("pedido no encontrado → skipped", async () => {
    seedOpp({ stage_id: S.cotizacion, shopify_order_id: "SO-999" });
    seedOrder("paid", null); // order is SO-100, opp points to SO-999
    const r = await run(() => applyPostventaTransition("opp-1"));
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("order_not_found");
  });

  it("opp cancelada administrativamente → skipped", async () => {
    seedOpp({ stage_id: S.cotizacion, cancelled_at: "2026-06-05T00:00:00Z" });
    seedOrder("paid", null);
    const r = await run(() => applyPostventaTransition("opp-1"));
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("opportunity_cancelled");
  });

  it("opp de Venta (no post_venta) → skipped", async () => {
    seedOpp({ stage_id: S.cotizacion, funnel: "venta" });
    seedOrder("paid", null);
    const r = await run(() => applyPostventaTransition("opp-1"));
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("not_post_venta");
  });
});

describe("backfill_in_progress (modo pasivo M11)", () => {
  it("flag pasado como true → skipped, no mueve", async () => {
    seedOpp({ stage_id: S.cotizacion });
    seedOrder("paid", null);
    const r = await run(() =>
      applyPostventaTransition("opp-1", { backfillInProgress: true }),
    );
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("backfill_in_progress");
    expect(currentStage()).toBe(S.cotizacion);
  });

  it("org con backfill_in_progress=true en BD → skipped (lectura del flag)", async () => {
    fake.setTable("organizations", [
      { id: ORG, backfill_in_progress: true },
    ]);
    seedOpp({ stage_id: S.cotizacion });
    seedOrder("paid", null);
    const r = await run(() => applyPostventaTransition("opp-1"));
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("backfill_in_progress");
  });

  it("flag pasado como false → procede normal (no relee org)", async () => {
    seedOpp({ stage_id: S.cotizacion });
    seedOrder("paid", null);
    const r = await run(() =>
      applyPostventaTransition("opp-1", { backfillInProgress: false }),
    );
    expect(r.status).toBe("moved");
    expect(currentStage()).toBe(S.pago);
  });
});
