import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readPipelineMinDateIso } from "@/lib/services/pipeline-visibility";

/**
 * Piso de visibilidad del pipeline (cutoff de arranque). El default es
 * 2026-06-01 interpretado como inicio de día en CDMX (UTC-6, sin DST) →
 * 2026-06-01T06:00:00.000Z. Sobreescribible por org en
 * organizations.config.pipeline.min_effective_date.
 */
describe("readPipelineMinDateIso", () => {
  const DEFAULT_UTC = "2026-06-01T06:00:00.000Z";

  it("default (config nula) → 1-jun-2026 inicio de día CDMX en UTC", () => {
    expect(readPipelineMinDateIso(null)).toBe(DEFAULT_UTC);
    expect(readPipelineMinDateIso(undefined)).toBe(DEFAULT_UTC);
    expect(readPipelineMinDateIso({})).toBe(DEFAULT_UTC);
  });

  it("respeta el override de la org (config.pipeline.min_effective_date)", () => {
    expect(
      readPipelineMinDateIso({ pipeline: { min_effective_date: "2026-03-15" } }),
    ).toBe("2026-03-15T06:00:00.000Z");
  });

  it("fecha inválida o clave ausente → cae al default", () => {
    expect(
      readPipelineMinDateIso({ pipeline: { min_effective_date: "no-es-fecha" } }),
    ).toBe(DEFAULT_UTC);
    expect(readPipelineMinDateIso({ pipeline: {} })).toBe(DEFAULT_UTC);
    expect(readPipelineMinDateIso({ pipeline: { hide_closed_after_days: 7 } })).toBe(
      DEFAULT_UTC,
    );
  });
});
