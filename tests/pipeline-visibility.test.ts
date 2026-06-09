import { describe, expect, it } from "vitest";
import {
  closedFilterForStage,
  computeClosedCutoffIso,
  partitionClosedStages,
  readHideClosedDays,
  sanitizeHideClosedDays,
} from "@/lib/services/pipeline-visibility";
import { DEFAULT_HIDE_CLOSED_AFTER_DAYS } from "@/lib/constants";

describe("readHideClosedDays", () => {
  it("lee el umbral de config.pipeline.hide_closed_after_days", () => {
    expect(readHideClosedDays({ pipeline: { hide_closed_after_days: 14 } })).toBe(14);
  });

  it("fallback al default cuando falta la clave o config", () => {
    expect(readHideClosedDays(null)).toBe(DEFAULT_HIDE_CLOSED_AFTER_DAYS);
    expect(readHideClosedDays({})).toBe(DEFAULT_HIDE_CLOSED_AFTER_DAYS);
    expect(readHideClosedDays({ pipeline: {} })).toBe(DEFAULT_HIDE_CLOSED_AFTER_DAYS);
    expect(readHideClosedDays({ thresholds: { x: 1 } })).toBe(
      DEFAULT_HIDE_CLOSED_AFTER_DAYS,
    );
  });

  it("acepta 0 (ocultar apenas se cierra) y satura negativos/altos", () => {
    expect(readHideClosedDays({ pipeline: { hide_closed_after_days: 0 } })).toBe(0);
    expect(readHideClosedDays({ pipeline: { hide_closed_after_days: -5 } })).toBe(0);
    expect(readHideClosedDays({ pipeline: { hide_closed_after_days: 9999 } })).toBe(365);
  });

  it("ignora valores no numéricos", () => {
    expect(readHideClosedDays({ pipeline: { hide_closed_after_days: "abc" } })).toBe(
      DEFAULT_HIDE_CLOSED_AFTER_DAYS,
    );
  });
});

describe("sanitizeHideClosedDays", () => {
  it("trunca, satura y cae al default ante NaN", () => {
    expect(sanitizeHideClosedDays(7.9)).toBe(7);
    expect(sanitizeHideClosedDays(-1)).toBe(0);
    expect(sanitizeHideClosedDays(1000)).toBe(365);
    expect(sanitizeHideClosedDays(Number.NaN)).toBe(DEFAULT_HIDE_CLOSED_AFTER_DAYS);
  });
});

describe("closedFilterForStage", () => {
  const cutoff = "2026-06-02T00:00:00.000Z";

  it("usa won_at para etapa Ganada", () => {
    expect(closedFilterForStage({ is_won: true, is_lost: false }, cutoff)).toEqual({
      column: "won_at",
      sinceIso: cutoff,
    });
  });

  it("usa lost_at para etapa Perdida", () => {
    expect(closedFilterForStage({ is_won: false, is_lost: true }, cutoff)).toEqual({
      column: "lost_at",
      sinceIso: cutoff,
    });
  });

  it("retorna null para etapa activa (nunca se oculta)", () => {
    expect(closedFilterForStage({ is_won: false, is_lost: false }, cutoff)).toBeNull();
  });
});

describe("partitionClosedStages", () => {
  it("separa won/lost e ignora activas", () => {
    const { wonStageIds, lostStageIds } = partitionClosedStages([
      { id: "a", is_won: false, is_lost: false },
      { id: "b", is_won: true, is_lost: false },
      { id: "c", is_won: false, is_lost: true },
      { id: "d", is_won: true, is_lost: false },
    ]);
    expect(wonStageIds).toEqual(["b", "d"]);
    expect(lostStageIds).toEqual(["c"]);
  });
});

describe("computeClosedCutoffIso", () => {
  it("retorna un ISO en el pasado proporcional a los días", () => {
    const now = Date.now();
    const cutoff7 = computeClosedCutoffIso(7);
    const cutoff0 = computeClosedCutoffIso(0);
    expect(new Date(cutoff7).getTime()).toBeLessThan(now);
    // 0 días ≈ ahora (dentro de un margen amplio).
    expect(Math.abs(new Date(cutoff0).getTime() - now)).toBeLessThan(60_000);
    // 7 días atrás está antes que 0 días atrás.
    expect(new Date(cutoff7).getTime()).toBeLessThan(new Date(cutoff0).getTime());
  });
});
