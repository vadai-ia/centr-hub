import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  computePostventaMetrics,
  computeVentaMetrics,
  type PostventaRaw,
  type VentaRaw,
} from "@/lib/services/dashboard-metrics";
import type { VentaStageBoundaries } from "@/lib/services/dashboard-stages";
import type { PipelineStageRow } from "@/lib/types/database";

/**
 * Correctitud de los KPIs del Dashboard (M8.2) — se testean las
 * funciones puras de agregación con fixtures (sin BD). Cubre lo más
 * propenso a error: leads/calificados vía histórico (dedupe),
 * win/loss rate, pipeline $ bruto (coalesce + excluir ganadas/perdidas),
 * activas-con-cotización por posición, sales cycle y filtrado por scope.
 */

const A = "adv-A";
const B = "adv-B";
const PERIOD = {
  startUtc: "2026-05-01T06:00:00.000Z",
  endUtc: "2026-06-01T05:59:59.999Z",
  startLabel: "2026-05-01",
  endLabel: "2026-05-31",
};

function stage(id: string, name: string, position: number, flags: Partial<PipelineStageRow> = {}): PipelineStageRow {
  return {
    id,
    organization_id: "org",
    funnel: "venta",
    name,
    position,
    color: "#000",
    default_probability: null,
    is_initial: false,
    is_won: false,
    is_lost: false,
    requires_loss_reason: false,
    is_active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...flags,
  };
}

const LEAD = stage("s-lead", "Lead nuevo", 1, { is_initial: true });
const CONTACTADO = stage("s-cont", "Contactado asesor", 2);
const CALIF = stage("s-cal", "Contacto calificado", 3);
const DISENO = stage("s-dis", "Diseño de espacios", 4);
const COTIZ = stage("s-cot", "Cotización", 5);
const GANADA = stage("s-won", "Ganada", 6, { is_won: true });
const PERDIDA = stage("s-lost", "Perdida", 7, { is_lost: true });
const STAGES = [LEAD, CONTACTADO, CALIF, DISENO, COTIZ, GANADA, PERDIDA];

const boundaries: VentaStageBoundaries = {
  stages: STAGES,
  cotizacionPosition: 5,
  qualifiedPosition: 3,
  initialStage: LEAD,
  wonStage: GANADA,
  lostStage: PERDIDA,
  qualifiedBandStageIds: [CALIF.id, DISENO.id],
  byId: new Map(STAGES.map((s) => [s.id, s])),
};

function ventaRaw(): VentaRaw {
  return {
    period: PERIOD,
    boundaries,
    lossReasonNames: new Map([["r1", "Precio"]]),
    paidOrders: [
      { assigned_advisor_id: A, is_outbound: false, total_amount: "100", paid_at: "2026-05-10T18:00:00.000Z" },
      { assigned_advisor_id: A, is_outbound: false, total_amount: "200", paid_at: "2026-05-12T18:00:00.000Z" },
      { assigned_advisor_id: B, is_outbound: false, total_amount: "50", paid_at: "2026-05-12T18:00:00.000Z" },
      { assigned_advisor_id: null, is_outbound: false, total_amount: "30", paid_at: "2026-05-12T18:00:00.000Z" },
    ],
    draftOpps: [{ assigned_advisor_id: A, is_outbound: false }, { assigned_advisor_id: A, is_outbound: false }, { assigned_advisor_id: B, is_outbound: false }],
    wonOpps: [
      { assigned_advisor_id: A, is_outbound: false, effective_created_at: "2026-05-01T06:00:00.000Z", won_at: "2026-05-11T06:00:00.000Z", actual_amount: "100", estimated_amount: null },
      { assigned_advisor_id: B, is_outbound: false, effective_created_at: "2026-05-01T06:00:00.000Z", won_at: "2026-05-21T06:00:00.000Z", actual_amount: "50", estimated_amount: null },
    ],
    // "Pipeline $ en el periodo" — opps vivas CREADAS en el periodo.
    livePipeline: [
      { assigned_advisor_id: A, is_outbound: false, stage_id: CALIF.id, shopify_draft_order_id: null, actual_amount: null, estimated_amount: "40" },
      { assigned_advisor_id: A, is_outbound: false, stage_id: COTIZ.id, shopify_draft_order_id: "d1", actual_amount: "100", estimated_amount: null },
      { assigned_advisor_id: B, is_outbound: false, stage_id: DISENO.id, shopify_draft_order_id: "d2", actual_amount: "60", estimated_amount: null },
      // Excluidas del pipeline $ (etapa ganada/perdida):
      { assigned_advisor_id: A, is_outbound: false, stage_id: GANADA.id, shopify_draft_order_id: "d3", actual_amount: "999", estimated_amount: null },
      { assigned_advisor_id: A, is_outbound: false, stage_id: PERDIDA.id, shopify_draft_order_id: null, actual_amount: "500", estimated_amount: null },
    ],
    // SNAPSHOT del ahora ("Activas" + "Pipeline $ actual") — superset del
    // periodo: incluye una opp en Cotización con draft CREADA antes del
    // periodo pero viva hoy (d4). Reproduce el caso "kanban=2 con draft,
    // pero snapshot=2" que el filtro de fecha escondía.
    livePipelineSnapshot: [
      { assigned_advisor_id: A, is_outbound: false, stage_id: CALIF.id, shopify_draft_order_id: null, actual_amount: null, estimated_amount: "40" },
      { assigned_advisor_id: A, is_outbound: false, stage_id: COTIZ.id, shopify_draft_order_id: "d1", actual_amount: "100", estimated_amount: null },
      { assigned_advisor_id: B, is_outbound: false, stage_id: DISENO.id, shopify_draft_order_id: "d2", actual_amount: "60", estimated_amount: null },
      // Vieja-pero-viva, fuera del periodo → solo el snapshot la captura:
      { assigned_advisor_id: A, is_outbound: false, stage_id: COTIZ.id, shopify_draft_order_id: "d4", actual_amount: "80", estimated_amount: null },
      // Perdida → excluida del snapshot por etapa terminal:
      { assigned_advisor_id: A, is_outbound: false, stage_id: PERDIDA.id, shopify_draft_order_id: null, actual_amount: "500", estimated_amount: null },
    ],
    lostEntries: [
      { opportunity_id: "l1", assigned_advisor_id: A, is_outbound: false, actual_amount: "70", estimated_amount: null, loss_reason_id: "r1" },
      { opportunity_id: "l2", assigned_advisor_id: B, is_outbound: false, actual_amount: null, estimated_amount: null, loss_reason_id: null },
    ],
    stageEntries: [
      { opportunity_id: "o1", to_stage_id: LEAD.id, assigned_advisor_id: A, is_outbound: false },
      { opportunity_id: "o2", to_stage_id: LEAD.id, assigned_advisor_id: B, is_outbound: false },
      { opportunity_id: "o1", to_stage_id: CALIF.id, assigned_advisor_id: A, is_outbound: false },
      { opportunity_id: "o3", to_stage_id: CALIF.id, assigned_advisor_id: A, is_outbound: false },
      { opportunity_id: "o1", to_stage_id: DISENO.id, assigned_advisor_id: A, is_outbound: false }, // dup en banda
    ],
    maxNonLostPos: new Map([
      ["o1", 5],
      ["o2", 1],
      ["o3", 3],
    ]),
  };
}

describe("computeVentaMetrics — scope 'all'", () => {
  const m = computeVentaMetrics(ventaRaw(), "all");

  it("revenue suma todas las órdenes pagadas (incluye sin asignar)", () => {
    expect(m.revenue).toBe(380);
  });
  it("cotizaciones enviadas = conteo de drafts", () => {
    expect(m.quotesSent).toBe(3);
  });
  it("pipeline $ EN EL PERIODO bruto coalesce actual||estimated, excluye ganadas/perdidas", () => {
    expect(m.pipelineGrossPeriod).toBe(200); // 40 + 100 + 60 (creadas en periodo)
  });
  it("pipeline $ ACTUAL (snapshot) suma vivas ahora, incluye vieja-pero-viva, excluye perdida", () => {
    expect(m.pipelineGrossNow).toBe(280); // 40 + 100 + 60 + 80 (d4 fuera de periodo); 500 perdida fuera
  });
  it("activas con cotización = snapshot del ahora (con draft, posición ≥ Cotización)", () => {
    expect(m.activeWithDraft).toBe(2); // d1 y d4 (la vieja-pero-viva); el filtro de fecha escondía d4
  });
  it("leads = opps distintas que entraron a la etapa inicial", () => {
    expect(m.leads).toBe(2); // o1, o2
  });
  it("leads calificados = opps distintas en la banda calificada (dedupe)", () => {
    expect(m.qualifiedLeads).toBe(2); // o1 (dup calif+diseño), o3
  });
  it("ganadas + win/loss rate excluyendo nada extra", () => {
    expect(m.wonCount).toBe(2);
    expect(m.winRateGlobal).toBeCloseTo(0.5);
    expect(m.lossRate).toBeCloseTo(0.5);
  });
  it("sales cycle promedio = (10 + 20) / 2", () => {
    expect(m.salesCycleDays).toBeCloseTo(15);
  });
  it("pérdidas por motivo agrupa y nombra (incluye 'Sin motivo')", () => {
    const precio = m.lossesByReason.find((r) => r.reasonName === "Precio");
    const sin = m.lossesByReason.find((r) => r.reasonName === "Sin motivo");
    expect(precio).toMatchObject({ count: 1, amount: 70 });
    expect(sin).toMatchObject({ count: 1, amount: 0 });
  });
  it("win rate por etapa solo etapas no terminales + % directo (sin muestra pequeña)", () => {
    expect(m.winRateByStage).toHaveLength(5); // excluye ganada y perdida
    const lead = m.winRateByStage.find((s) => s.stageId === LEAD.id)!;
    expect(lead.sample).toBe(2); // o1, o2
    // o1 (maxPos 5 > 1) avanzó; o2 (maxPos 1) no → 1/2 (#8: ya no hay
    // umbral de muestra; el % se calcula siempre).
    expect(lead.rate).toBeCloseTo(0.5);
    expect("smallSample" in lead).toBe(false);
  });
});

describe("computeVentaMetrics — scope por asesor A", () => {
  const m = computeVentaMetrics(ventaRaw(), A);
  it("filtra revenue/cotizaciones/pipeline al asesor", () => {
    expect(m.revenue).toBe(300);
    expect(m.quotesSent).toBe(2);
    expect(m.pipelineGrossPeriod).toBe(140); // CALIF 40 + COTIZ 100 (DISENO es de B)
    expect(m.pipelineGrossNow).toBe(220); // snapshot A: 40 + 100 + 80 (d4)
    expect(m.activeWithDraft).toBe(2); // d1 y d4 de A
  });
  it("leads y calificados del asesor", () => {
    expect(m.leads).toBe(1); // solo o1 (o2 es de B)
    expect(m.qualifiedLeads).toBe(2); // o1, o3
  });
  it("win/loss del asesor", () => {
    expect(m.wonCount).toBe(1);
    expect(m.winRateGlobal).toBeCloseTo(0.5); // 1 ganada / (1+1)
    expect(m.salesCycleDays).toBeCloseTo(10);
  });
});

describe("computeVentaMetrics — división por cero", () => {
  it("sin ganadas ni perdidas → rates null (no NaN)", () => {
    const raw = ventaRaw();
    raw.wonOpps = [];
    raw.lostEntries = [];
    const m = computeVentaMetrics(raw, "all");
    expect(m.winRateGlobal).toBeNull();
    expect(m.lossRate).toBeNull();
    expect(m.salesCycleDays).toBeNull();
  });
});

describe("computePostventaMetrics", () => {
  const TERMINAL = new Set(["pv-won", "pv-lost"]);
  function postRaw(): PostventaRaw {
    return {
      period: PERIOD,
      ordersCreated: [
        { assigned_advisor_id: A, is_outbound: false, shopify_created_at: "2026-05-10T18:00:00.000Z" },
        { assigned_advisor_id: A, is_outbound: false, shopify_created_at: "2026-05-11T18:00:00.000Z" },
        { assigned_advisor_id: B, is_outbound: false, shopify_created_at: "2026-05-12T18:00:00.000Z" },
        { assigned_advisor_id: null, is_outbound: false, shopify_created_at: "2026-05-13T18:00:00.000Z" },
      ],
      problematicOpps: [{ assigned_advisor_id: A, is_outbound: false }, { assigned_advisor_id: B, is_outbound: false }],
      postventaStages: { problematicStage: null, terminalStageIds: TERMINAL },
      // Pedidos activos ahora = órdenes DISTINTAS con opp post-venta viva.
      liveOpps: [
        { id: "p1", assigned_advisor_id: A, is_outbound: false, stage_id: "pv-open", shopify_order_id: "O1" },
        { id: "p2", assigned_advisor_id: A, is_outbound: false, stage_id: "pv-open", shopify_order_id: "O1" }, // misma orden O1 → dedupe
        { id: "p3", assigned_advisor_id: A, is_outbound: false, stage_id: "pv-open", shopify_order_id: "O2" },
        { id: "p4", assigned_advisor_id: B, is_outbound: false, stage_id: "pv-open", shopify_order_id: "O3" },
        { id: "p5", assigned_advisor_id: A, is_outbound: false, stage_id: "pv-won", shopify_order_id: "O4" }, // terminal → excluida
        { id: "p6", assigned_advisor_id: A, is_outbound: false, stage_id: "pv-open", shopify_order_id: null }, // sin orden → cuenta por su id
      ],
    };
  }

  it("scope 'all': pedidos creados, casos y pedidos activos (dedupe por orden, excluye terminal)", () => {
    const m = computePostventaMetrics(postRaw(), "all");
    expect(m.ordersCount).toBe(4);
    expect(m.problematicCases).toBe(2);
    expect(m.activeOrders).toBe(4); // O1, O2, O3, opp:p6 (p5 terminal fuera)
  });

  it("scope por asesor A", () => {
    const m = computePostventaMetrics(postRaw(), A);
    expect(m.ordersCount).toBe(2);
    expect(m.problematicCases).toBe(1);
    expect(m.activeOrders).toBe(3); // O1, O2, opp:p6 (p4 es de B; p5 terminal)
  });

  it("sin opps vivas → activos 0", () => {
    const raw = postRaw();
    raw.liveOpps = [];
    const m = computePostventaMetrics(raw, "all");
    expect(m.activeOrders).toBe(0);
  });
});

describe("computeVentaMetrics — corte por canal (F4)", () => {
  function mixedRaw(): VentaRaw {
    return {
      period: PERIOD,
      boundaries,
      lossReasonNames: new Map(),
      paidOrders: [
        { assigned_advisor_id: A, is_outbound: true, total_amount: "100", paid_at: "2026-05-10T18:00:00.000Z" },
        { assigned_advisor_id: A, is_outbound: false, total_amount: "50", paid_at: "2026-05-11T18:00:00.000Z" },
      ],
      draftOpps: [
        { assigned_advisor_id: A, is_outbound: true },
        { assigned_advisor_id: A, is_outbound: false },
      ],
      wonOpps: [
        { assigned_advisor_id: A, is_outbound: true, effective_created_at: "2026-05-01T06:00:00.000Z", won_at: "2026-05-11T06:00:00.000Z", actual_amount: "100", estimated_amount: null },
        { assigned_advisor_id: A, is_outbound: false, effective_created_at: "2026-05-01T06:00:00.000Z", won_at: "2026-05-12T06:00:00.000Z", actual_amount: "50", estimated_amount: null },
      ],
      livePipeline: [],
      livePipelineSnapshot: [],
      lostEntries: [],
      stageEntries: [],
      maxNonLostPos: new Map(),
    };
  }

  it("outbound: solo filas outbound", () => {
    const m = computeVentaMetrics(mixedRaw(), "all", "outbound");
    expect(m.revenue).toBe(100);
    expect(m.quotesSent).toBe(1);
    expect(m.wonCount).toBe(1);
  });
  it("inbound: solo filas NO outbound", () => {
    const m = computeVentaMetrics(mixedRaw(), "all", "inbound");
    expect(m.revenue).toBe(50);
    expect(m.quotesSent).toBe(1);
    expect(m.wonCount).toBe(1);
  });
  it("all: ambos (default)", () => {
    const m = computeVentaMetrics(mixedRaw(), "all", "all");
    expect(m.revenue).toBe(150);
    expect(m.quotesSent).toBe(2);
    expect(m.wonCount).toBe(2);
    // Sin canal explícito = "all".
    expect(computeVentaMetrics(mixedRaw(), "all").revenue).toBe(150);
  });
  it("canal se combina con scope (asesor)", () => {
    const m = computeVentaMetrics(mixedRaw(), A, "outbound");
    expect(m.revenue).toBe(100);
    const none = computeVentaMetrics(mixedRaw(), B, "outbound");
    expect(none.revenue).toBe(0);
  });
});
