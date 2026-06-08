import { afterEach, describe, expect, it } from "vitest";
import { DateTime, Settings } from "luxon";
import {
  monthKeyInTz,
  monthKeysInPeriod,
  resolveCustomPeriod,
  resolvePresetPeriod,
} from "@/lib/time/period";

/**
 * Periodos del Dashboard (M8.2). Valida que los límites se calculen en
 * America/Mexico_City y se conviertan a UTC — el bug clásico servidor
 * UTC vs cliente MX. El reloj se fija con Settings.now para
 * determinismo.
 */

afterEach(() => {
  Settings.now = () => Date.now();
});

function freezeAt(iso: string) {
  const ms = DateTime.fromISO(iso, { zone: "utc" }).toMillis();
  Settings.now = () => ms;
}

describe("resolveCustomPeriod", () => {
  it("acepta desde ≤ hasta y ancla a inicio/fin de día en MX (UTC-6)", () => {
    const res = resolveCustomPeriod("2026-05-01", "2026-05-31");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 2026-05-01 00:00 MX = 06:00 UTC.
    expect(res.period.startUtc).toBe("2026-05-01T06:00:00.000Z");
    // 2026-05-31 23:59:59.999 MX = 2026-06-01 05:59:59.999 UTC.
    expect(res.period.endUtc).toBe("2026-06-01T05:59:59.999Z");
    expect(res.period.startLabel).toBe("2026-05-01");
    expect(res.period.endLabel).toBe("2026-05-31");
  });

  it("rechaza desde > hasta", () => {
    const res = resolveCustomPeriod("2026-05-31", "2026-05-01");
    expect(res).toEqual({ ok: false, reason: "from_after_to" });
  });

  it("rechaza formato inválido", () => {
    const res = resolveCustomPeriod("no-es-fecha", "2026-05-01");
    expect(res).toEqual({ ok: false, reason: "invalid_format" });
  });
});

describe("resolvePresetPeriod", () => {
  it("'today' cubre solo el día de hoy en MX aunque en UTC ya sea otro día", () => {
    // 2026-06-08 02:00 UTC = 2026-06-07 20:00 MX → 'hoy' debe ser el 7.
    freezeAt("2026-06-08T02:00:00.000Z");
    const p = resolvePresetPeriod("today");
    expect(p.startLabel).toBe("2026-06-07");
    expect(p.endLabel).toBe("2026-06-07");
  });

  it("'7d' abarca 7 días inclusivos terminando hoy (MX)", () => {
    freezeAt("2026-06-08T18:00:00.000Z"); // 12:00 MX del 8-jun
    const p = resolvePresetPeriod("7d");
    expect(p.startLabel).toBe("2026-06-02");
    expect(p.endLabel).toBe("2026-06-08");
  });
});

describe("monthKeyInTz", () => {
  it("bucketiza un pago de 23:00 MX del último día del mes en ese mes, no en el siguiente", () => {
    // 2026-06-01 04:00 UTC = 2026-05-31 22:00 MX → mayo.
    expect(monthKeyInTz("2026-06-01T04:00:00.000Z")).toBe("2026-05");
  });
});

describe("monthKeysInPeriod", () => {
  it("lista todos los meses del rango, incluidos los vacíos", () => {
    const res = resolveCustomPeriod("2026-03-15", "2026-05-10");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(monthKeysInPeriod(res.period)).toEqual(["2026-03", "2026-04", "2026-05"]);
  });
});
