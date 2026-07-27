import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  computeVentaMetrics,
  tallyAchievement,
  type Scope,
  type VentaRaw,
} from "@/lib/services/dashboard-metrics";
import type { VentaStageBoundaries } from "@/lib/services/dashboard-stages";
import {
  currentMonthKey,
  resolveCurrentMonthPeriod,
} from "@/lib/time/period";

/**
 * B2 — avance de metas. Verifica (1) que `tallyAchievement` cuenta/suma por
 * scope correctamente, (2) que NO puede divergir de los KPIs del Dashboard
 * (`computeVentaMetrics` produce los mismos quotes/won/amount), y (3) los
 * bordes de mes en CDMX de `resolveCurrentMonthPeriod`.
 */

const A = "adv-A";
const B = "adv-B";
const PERIOD = {
  startUtc: "2026-05-01T06:00:00.000Z",
  endUtc: "2026-06-01T05:59:59.999Z",
  startLabel: "2026-05-01",
  endLabel: "2026-05-31",
};

const emptyBoundaries: VentaStageBoundaries = {
  stages: [],
  cotizacionPosition: 0,
  qualifiedPosition: 0,
  initialStage: null,
  wonStage: null,
  lostStage: null,
  qualifiedBandStageIds: [],
  byId: new Map(),
};

function raw(): VentaRaw {
  return {
    period: PERIOD,
    boundaries: emptyBoundaries,
    lossReasonNames: new Map(),
    paidOrders: [
      { assigned_advisor_id: A, is_outbound: false, total_amount: "100", paid_at: "2026-05-10T18:00:00.000Z" },
      { assigned_advisor_id: A, is_outbound: false, total_amount: "200", paid_at: "2026-05-12T18:00:00.000Z" },
      { assigned_advisor_id: B, is_outbound: false, total_amount: "50", paid_at: "2026-05-12T18:00:00.000Z" },
      { assigned_advisor_id: null, is_outbound: false, total_amount: "30", paid_at: "2026-05-12T18:00:00.000Z" },
    ],
    draftOpps: [
      { assigned_advisor_id: A, is_outbound: false },
      { assigned_advisor_id: A, is_outbound: false },
      { assigned_advisor_id: B, is_outbound: false },
    ],
    wonOpps: [
      { assigned_advisor_id: A, is_outbound: false, effective_created_at: "2026-05-01T06:00:00.000Z", won_at: "2026-05-11T06:00:00.000Z", actual_amount: "100", estimated_amount: null },
      { assigned_advisor_id: B, is_outbound: false, effective_created_at: "2026-05-01T06:00:00.000Z", won_at: "2026-05-21T06:00:00.000Z", actual_amount: "50", estimated_amount: null },
      { assigned_advisor_id: A, is_outbound: false, effective_created_at: "2026-05-01T06:00:00.000Z", won_at: "2026-05-22T06:00:00.000Z", actual_amount: "70", estimated_amount: null },
    ],
    livePipeline: [],
    livePipelineSnapshot: [],
    lostEntries: [],
    stageEntries: [],
    maxNonLostPos: new Map(),
  };
}

describe("tallyAchievement", () => {
  it("cuenta/suma por vendedor", () => {
    expect(tallyAchievement(raw().paidOrders, raw().draftOpps, raw().wonOpps, A)).toEqual({
      quotes: 2,
      won: 2,
      amount: 300,
    });
    expect(tallyAchievement(raw().paidOrders, raw().draftOpps, raw().wonOpps, B)).toEqual({
      quotes: 1,
      won: 1,
      amount: 50,
    });
  });
  it("scope 'all' incluye sin-asignar (totales de la org)", () => {
    expect(tallyAchievement(raw().paidOrders, raw().draftOpps, raw().wonOpps, "all")).toEqual({
      quotes: 3,
      won: 3,
      amount: 380,
    });
  });
  it("scope null = solo sin-asignar", () => {
    expect(tallyAchievement(raw().paidOrders, raw().draftOpps, raw().wonOpps, null)).toEqual({
      quotes: 0,
      won: 0,
      amount: 30,
    });
  });
});

describe("paridad tally ↔ computeVentaMetrics (no pueden divergir)", () => {
  const scopes: Scope[] = [A, B, "all", null];
  it.each(scopes)("scope %s coincide con los KPIs del Dashboard", (scope) => {
    const r = raw();
    const venta = computeVentaMetrics(r, scope);
    const t = tallyAchievement(r.paidOrders, r.draftOpps, r.wonOpps, scope);
    expect(venta.revenue).toBe(t.amount);
    expect(venta.quotesSent).toBe(t.quotes);
    expect(venta.wonCount).toBe(t.won);
  });
});

describe("resolveCurrentMonthPeriod (bordes de mes en CDMX)", () => {
  afterEach(() => vi.useRealTimers());

  it("del 1° 00:00 MX al fin del último día del mes (MX es UTC-6)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T18:00:00.000Z")); // 12:00 MX, 18-jun
    const p = resolveCurrentMonthPeriod();
    expect(p.startUtc).toBe("2026-06-01T06:00:00.000Z");
    expect(p.endUtc).toBe("2026-07-01T05:59:59.999Z");
    expect(currentMonthKey()).toBe("2026-06");
  });

  it("a las 23:30 MX del último día sigue siendo el mismo mes (no salta por UTC)", () => {
    vi.useFakeTimers();
    // 2026-05-31 23:30 MX = 2026-06-01 05:30 UTC.
    vi.setSystemTime(new Date("2026-06-01T05:30:00.000Z"));
    expect(currentMonthKey()).toBe("2026-05");
    expect(resolveCurrentMonthPeriod().startUtc).toBe("2026-05-01T06:00:00.000Z");
  });
});
