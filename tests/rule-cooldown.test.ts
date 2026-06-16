import { describe, expect, it } from "vitest";
import {
  thresholdHoursFromConfig,
  reinsistCooldownSinceIso,
} from "@/lib/automation/rule-config";

/**
 * Cooldown de re-insistencia (correctivo M1v2): tras completar una tarea de
 * regla, esta se vuelve a crear solo después de un período COMPLETO del
 * propio umbral de la regla — no al tick siguiente. Cada regla insiste a SU
 * ritmo; el valor sale de su `trigger_config`, no es fijo. Estos tests fijan
 * esa composición (umbral → ventana de corte) como contrato.
 */
describe("reinsistCooldownSinceIso — ventana = umbral propio de la regla", () => {
  const now = Date.parse("2026-06-15T12:00:00.000Z");

  it("stage_aging de 24h en etapa → corte 24h atrás", () => {
    const hours = thresholdHoursFromConfig({ stage_name: "Cotización", hours_in_stage: 24 } as never);
    expect(hours).toBe(24);
    expect(reinsistCooldownSinceIso(now, hours)).toBe("2026-06-14T12:00:00.000Z");
  });

  it("no_activity de 72h → corte 72h atrás", () => {
    const hours = thresholdHoursFromConfig({ hours_without_activity: 72 });
    expect(hours).toBe(72);
    expect(reinsistCooldownSinceIso(now, hours)).toBe("2026-06-12T12:00:00.000Z");
  });

  it("expresado en días (3 días sin actividad) → corte 72h atrás (días×24)", () => {
    const hours = thresholdHoursFromConfig({ days_without_activity: 3 });
    expect(hours).toBe(72);
    expect(reinsistCooldownSinceIso(now, hours)).toBe("2026-06-12T12:00:00.000Z");
  });

  it("dos reglas distintas producen ventanas DISTINTAS (no es un valor fijo)", () => {
    const a = reinsistCooldownSinceIso(now, thresholdHoursFromConfig({ hours_in_stage: 24 } as never));
    const b = reinsistCooldownSinceIso(now, thresholdHoursFromConfig({ days_in_stage: 7 } as never));
    expect(a).not.toBe(b);
    expect(b).toBe("2026-06-08T12:00:00.000Z"); // 7 días = 168h atrás
  });

  it("sin umbral de tiempo → sin cooldown (null)", () => {
    expect(reinsistCooldownSinceIso(now, thresholdHoursFromConfig({}))).toBeNull();
  });
});
