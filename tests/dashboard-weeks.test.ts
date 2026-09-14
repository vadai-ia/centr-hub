import { afterEach, describe, expect, it } from "vitest";
import { DateTime, Settings } from "luxon";
import { resolveCustomPeriod, weeksOfMonth } from "@/lib/time/period";

/**
 * Semanas del mes para la revisión semanal (weeksOfMonth).
 *
 * Pedido de la dirección: dar la meta el día 1 y reunirse cada lunes a revisar
 * la semana — "el lunes 7, cómo les fue del 1 al 6". Por eso la semana es
 * lunes–domingo RECORTADA al mes, no la semana ISO completa.
 */

afterEach(() => {
  Settings.now = () => Date.now();
});

function freezeAt(iso: string) {
  const ms = DateTime.fromISO(iso, { zone: "utc" }).toMillis();
  Settings.now = () => ms;
}

const ranges = (monthKey: string) => weeksOfMonth(monthKey).map((w) => [w.from, w.to]);

describe("weeksOfMonth", () => {
  it("septiembre 2026: lunes–domingo recortado al mes (el 1 cae en martes)", () => {
    freezeAt("2026-10-15T18:00:00.000Z");
    expect(ranges("2026-09")).toEqual([
      ["2026-09-01", "2026-09-06"],
      ["2026-09-07", "2026-09-13"],
      ["2026-09-14", "2026-09-20"],
      ["2026-09-21", "2026-09-27"],
      ["2026-09-28", "2026-09-30"],
    ]);
    expect(weeksOfMonth("2026-09")[0].label).toContain("1–6");
  });

  it("febrero 2026 (el 1 cae en domingo): la primera semana es de un solo día", () => {
    freezeAt("2026-10-15T18:00:00.000Z");
    const w = weeksOfMonth("2026-02");
    expect(w[0]).toMatchObject({ from: "2026-02-01", to: "2026-02-01" });
    expect(w[0].label.startsWith("1 ")).toBe(true);
    expect(w[w.length - 1].to).toBe("2026-02-28");
  });

  it("mes en curso: solo las semanas que ya empezaron", () => {
    freezeAt("2026-09-14T18:00:00.000Z"); // lunes 14-sep, mediodía MX
    expect(ranges("2026-09").map(([from]) => from)).toEqual([
      "2026-09-01",
      "2026-09-07",
      "2026-09-14",
    ]);
  });

  it("'hoy' se resuelve en MX, no en UTC", () => {
    // 2026-09-14 03:00 UTC = domingo 13-sep 21:00 MX → la semana del 14 aún no empieza.
    freezeAt("2026-09-14T03:00:00.000Z");
    expect(weeksOfMonth("2026-09")).toHaveLength(2);
  });

  it("un mes futuro no tiene semanas", () => {
    freezeAt("2026-09-14T18:00:00.000Z");
    expect(weeksOfMonth("2026-11")).toEqual([]);
  });

  it("cada semana es un periodo válido para el tablero", () => {
    freezeAt("2026-10-15T18:00:00.000Z");
    for (const w of weeksOfMonth("2026-09")) {
      expect(resolveCustomPeriod(w.from, w.to).ok).toBe(true);
    }
  });

  it("clave inválida → sin semanas", () => {
    expect(weeksOfMonth("2026-13")).toEqual([]);
  });
});
