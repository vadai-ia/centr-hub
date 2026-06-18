import { describe, expect, it } from "vitest";
import { readGoalThresholds } from "@/lib/services/metas-config";
import { DEFAULT_GOAL_THRESHOLDS } from "@/lib/metas/semaphore";
import { goalInputSchema, goalThresholdsInputSchema } from "@/lib/metas/schema";

describe("readGoalThresholds (config.metas con fallback)", () => {
  it("cae al default si config es null/undefined", () => {
    expect(readGoalThresholds(null)).toEqual(DEFAULT_GOAL_THRESHOLDS);
    expect(readGoalThresholds(undefined)).toEqual(DEFAULT_GOAL_THRESHOLDS);
  });
  it("cae al default si falta el bloque metas", () => {
    expect(readGoalThresholds({ pipeline: { hide_closed_after_days: 7 } })).toEqual(
      DEFAULT_GOAL_THRESHOLDS,
    );
  });
  it("lee los umbrales configurados", () => {
    expect(readGoalThresholds({ metas: { green_pct: 90, yellow_pct: 60 } })).toEqual({
      greenPct: 90,
      yellowPct: 60,
    });
  });
  it("sanea valores invertidos (amarillo no supera al verde)", () => {
    expect(readGoalThresholds({ metas: { green_pct: 70, yellow_pct: 95 } })).toEqual({
      greenPct: 70,
      yellowPct: 70,
    });
  });
  it("usa el default por-campo si una clave falta o es inválida", () => {
    // green presente, yellow ausente → yellow cae a default (50), saneado contra green.
    expect(readGoalThresholds({ metas: { green_pct: 90 } })).toEqual({
      greenPct: 90,
      yellowPct: 50,
    });
    expect(readGoalThresholds({ metas: { green_pct: "abc", yellow_pct: 40 } })).toEqual({
      greenPct: DEFAULT_GOAL_THRESHOLDS.greenPct,
      yellowPct: 40,
    });
  });
  it("ignora config en forma de array", () => {
    expect(readGoalThresholds([1, 2, 3] as never)).toEqual(DEFAULT_GOAL_THRESHOLDS);
  });
});

describe("goalInputSchema", () => {
  it("acepta meta de equipo (advisor null) y coacciona el objetivo string→number", () => {
    const parsed = goalInputSchema.parse({
      advisorMembershipId: null,
      metric: "amount",
      targetValue: "80000",
      isActive: true,
    });
    expect(parsed.targetValue).toBe(80000);
    expect(parsed.advisorMembershipId).toBeNull();
  });
  it("rechaza objetivo negativo y métrica inválida", () => {
    expect(
      goalInputSchema.safeParse({
        advisorMembershipId: null,
        metric: "amount",
        targetValue: -1,
        isActive: true,
      }).success,
    ).toBe(false);
    expect(
      goalInputSchema.safeParse({
        advisorMembershipId: null,
        metric: "revenue",
        targetValue: 10,
        isActive: true,
      }).success,
    ).toBe(false);
  });
});

describe("goalThresholdsInputSchema", () => {
  it("rechaza fuera de [0,100]", () => {
    expect(goalThresholdsInputSchema.safeParse({ greenPct: 120, yellowPct: 50 }).success).toBe(
      false,
    );
  });
  it("acepta enteros en rango", () => {
    expect(goalThresholdsInputSchema.parse({ greenPct: 85, yellowPct: 50 })).toEqual({
      greenPct: 85,
      yellowPct: 50,
    });
  });
});
