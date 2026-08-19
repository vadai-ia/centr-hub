import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  NO_SNAPSHOT_WINDOW,
  resolvePipelineSnapshotWindow,
} from "@/lib/services/dashboard-snapshot-window";
import { TIMEZONE } from "@/lib/constants";

/**
 * Corte por antigüedad del snapshot del dashboard.
 *
 * Invariante que protegen estos tests: **sin config, sin corte**. Una org
 * que no configuró la key debe comportarse exactamente como antes del
 * cambio (query idéntica → el snapshot sigue coincidiendo con el kanban).
 * Cualquier valor basura debe caer en ese mismo caso, no tumbar el
 * dashboard ni recortar por accidente.
 */
describe("resolvePipelineSnapshotWindow", () => {
  it("sin config → sin corte", () => {
    expect(resolvePipelineSnapshotWindow(null)).toEqual(NO_SNAPSHOT_WINDOW);
    expect(resolvePipelineSnapshotWindow(undefined)).toEqual(NO_SNAPSHOT_WINDOW);
    expect(resolvePipelineSnapshotWindow({})).toEqual(NO_SNAPSHOT_WINDOW);
    expect(resolvePipelineSnapshotWindow({ dashboard: {} })).toEqual(NO_SNAPSHOT_WINDOW);
  });

  it("config de otras features no activa el corte", () => {
    const config = {
      pipeline: { hide_closed_after_days: 7 },
      postventa: { customer_success_membership_id: "abc" },
      defaults: { currency: "MXN" },
    };
    expect(resolvePipelineSnapshotWindow(config)).toEqual(NO_SNAPSHOT_WINDOW);
  });

  it("fecha válida → inicio de ese día en CDMX, expresado en UTC", () => {
    const w = resolvePipelineSnapshotWindow({
      dashboard: { pipeline_snapshot_since: "2026-05-01" },
    });
    expect(w.sinceDate).toBe("2026-05-01");
    // México no usa DST desde 2022 → CDMX es UTC-6 todo el año.
    const expected = DateTime.fromISO("2026-05-01", { zone: TIMEZONE }).startOf("day").toUTC();
    expect(w.sinceUtc).toBe(expected.toISO());
    // El corte NO es medianoche UTC: eso metería 6 horas del día anterior.
    expect(w.sinceUtc).not.toBe("2026-05-01T00:00:00.000Z");
  });

  it("valores inválidos se ignoran en vez de lanzar", () => {
    for (const bad of ["", "   ", "no-es-fecha", "2026-13-45", 20260501, null, {}, []]) {
      expect(
        resolvePipelineSnapshotWindow({ dashboard: { pipeline_snapshot_since: bad } }),
        `valor: ${JSON.stringify(bad)}`,
      ).toEqual(NO_SNAPSHOT_WINDOW);
    }
  });

  it("config con forma inesperada no rompe", () => {
    expect(resolvePipelineSnapshotWindow([])).toEqual(NO_SNAPSHOT_WINDOW);
    expect(resolvePipelineSnapshotWindow("texto")).toEqual(NO_SNAPSHOT_WINDOW);
    expect(resolvePipelineSnapshotWindow({ dashboard: "texto" })).toEqual(NO_SNAPSHOT_WINDOW);
    expect(resolvePipelineSnapshotWindow({ dashboard: [] })).toEqual(NO_SNAPSHOT_WINDOW);
  });

  it("recorta espacios alrededor de la fecha", () => {
    const w = resolvePipelineSnapshotWindow({
      dashboard: { pipeline_snapshot_since: "  2026-05-01  " },
    });
    expect(w.sinceDate).toBe("2026-05-01");
    expect(w.sinceUtc).not.toBeNull();
  });
});
