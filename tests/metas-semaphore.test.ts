import { describe, expect, it } from "vitest";
import {
  DEFAULT_GOAL_THRESHOLDS,
  GOAL_DISPLAY_CEILING_PCT,
  GOAL_MARKER_LEFT_PCT,
  computeGoalPct,
  fillWidthPct,
  resolveGoalZone,
  sanitizeGoalThresholds,
} from "@/lib/metas/semaphore";

describe("computeGoalPct", () => {
  it("devuelve null si el objetivo es 0 o negativo (sin meta medible)", () => {
    expect(computeGoalPct(5, 0)).toBeNull();
    expect(computeGoalPct(5, -10)).toBeNull();
  });
  it("calcula logrado/objetivo*100", () => {
    expect(computeGoalPct(12, 20)).toBe(60);
    expect(computeGoalPct(20, 20)).toBe(100);
    expect(computeGoalPct(24, 20)).toBe(120);
  });
  it("permite superar 100 (sobrecumplimiento)", () => {
    expect(computeGoalPct(90, 50)).toBe(180);
  });
});

describe("resolveGoalZone (umbrales default 50/85)", () => {
  const t = DEFAULT_GOAL_THRESHOLDS;
  it("rojo debajo de yellowPct", () => {
    expect(resolveGoalZone(0, t)).toBe("red");
    expect(resolveGoalZone(49.9, t)).toBe("red");
  });
  it("amarillo en [yellowPct, greenPct)", () => {
    expect(resolveGoalZone(50, t)).toBe("yellow");
    expect(resolveGoalZone(84.9, t)).toBe("yellow");
  });
  it("verde en [greenPct, 100]", () => {
    expect(resolveGoalZone(85, t)).toBe("green");
    expect(resolveGoalZone(100, t)).toBe("green");
  });
  it("dorado SIEMPRE al superar 100, sin importar los cortes", () => {
    expect(resolveGoalZone(100.01, t)).toBe("gold");
    expect(resolveGoalZone(145, t)).toBe("gold");
    // incluso con umbrales raros, >100 manda
    expect(resolveGoalZone(101, { greenPct: 100, yellowPct: 100 })).toBe("gold");
  });
});

describe("fillWidthPct (escala fija 0–120)", () => {
  it("mapea el % real contra el techo de la escala", () => {
    expect(fillWidthPct(0)).toBe(0);
    expect(fillWidthPct(60)).toBeCloseTo(50, 5);
    expect(fillWidthPct(GOAL_DISPLAY_CEILING_PCT)).toBe(100);
  });
  it("la meta (100%) cae exactamente en la marca del 100%", () => {
    expect(fillWidthPct(100)).toBeCloseTo(GOAL_MARKER_LEFT_PCT, 5);
  });
  it("clampa al techo (% real mayor no desborda el track)", () => {
    expect(fillWidthPct(300)).toBe(100);
  });
  it("clampa negativos a 0", () => {
    expect(fillWidthPct(-50)).toBe(0);
  });
});

describe("sanitizeGoalThresholds", () => {
  it("respeta valores válidos", () => {
    expect(sanitizeGoalThresholds({ greenPct: 90, yellowPct: 60 })).toEqual({
      greenPct: 90,
      yellowPct: 60,
    });
  });
  it("impide que amarillo supere a verde (zona amarilla invertida)", () => {
    expect(sanitizeGoalThresholds({ greenPct: 70, yellowPct: 95 })).toEqual({
      greenPct: 70,
      yellowPct: 70,
    });
  });
  it("clampa a [0,100] y cae al default ante basura", () => {
    expect(sanitizeGoalThresholds({ greenPct: 999, yellowPct: -5 })).toEqual({
      greenPct: 100,
      yellowPct: 0,
    });
    expect(sanitizeGoalThresholds({ greenPct: NaN, yellowPct: NaN })).toEqual({
      greenPct: DEFAULT_GOAL_THRESHOLDS.greenPct,
      yellowPct: DEFAULT_GOAL_THRESHOLDS.yellowPct,
    });
  });
});
