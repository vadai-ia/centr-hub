import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { tallyAchievement } from "@/lib/services/dashboard-metrics";
import { achievedForMetric, closeRateOf } from "@/lib/metas/achievement";
import { formatGoalValue, goalInputSchema, metricsForSubject } from "@/lib/metas/schema";
import { recentMonthKeys } from "@/lib/time/period";

/**
 * % de cierre de cotizaciones como meta (0053).
 *
 * La pregunta de la dirección: "de 100 cotizaciones, ¿cuántas cerró?". Estos
 * tests fijan que la respuesta es por COHORTE — de las cotizaciones creadas en
 * el periodo, cuántas ya se ganaron — y no "ganadas ÷ cotizaciones del mes",
 * que mezclaría cierres de cotizaciones de meses anteriores.
 */

const A = "mem-A";

const quote = (won_at: string | null) => ({ assigned_advisor_id: A, is_outbound: false, won_at });
const wonOpp = () => ({
  assigned_advisor_id: A,
  is_outbound: false,
  effective_created_at: "2026-04-01T06:00:00.000Z",
  won_at: "2026-05-11T06:00:00.000Z",
  actual_amount: "100",
  estimated_amount: null,
});

describe("close_rate", () => {
  it("es cotizaciones ganadas ÷ cotizaciones del periodo, en 0–100", () => {
    const t = tallyAchievement([], [quote("2026-05-11T06:00:00.000Z"), quote(null), quote(null), quote(null)], [], A);
    expect(t.quotes).toBe(4);
    expect(t.quotesWon).toBe(1);
    expect(achievedForMetric("close_rate", t)).toBe(25);
  });

  it("es por COHORTE: ganadas de cotizaciones de otro mes no la inflan", () => {
    // 4 cotizaciones del mes (1 ganada) + 3 ventas de cotizaciones viejas.
    // Con "ganadas ÷ cotizaciones" daría 4/4 = 100%; la cohorte da 25%.
    const t = tallyAchievement(
      [],
      [quote("2026-05-11T06:00:00.000Z"), quote(null), quote(null), quote(null)],
      [wonOpp(), wonOpp(), wonOpp()],
      A,
    );
    expect(t.won).toBe(3);
    expect(achievedForMetric("close_rate", t)).toBe(25);
  });

  it("sin cotizaciones da 0 (no divide entre cero)", () => {
    const t = tallyAchievement([], [], [], A);
    expect(achievedForMetric("close_rate", t)).toBe(0);
  });

  it("las demás métricas no cambian de significado", () => {
    const t = { quotes: 7, won: 2, amount: 900, quotesWon: 1 };
    expect(achievedForMetric("quotes", t)).toBe(7);
    expect(achievedForMetric("won", t)).toBe(2);
    expect(achievedForMetric("amount", t)).toBe(900);
  });

  it("ya no se ofrece como meta a ningún sujeto (se calcula sola)", () => {
    for (const s of ["team", "advisor", "organic"] as const) {
      expect(metricsForSubject(s)).not.toContain("close_rate");
      expect(metricsForSubject(s)).not.toContain("quotes");
    }
  });

  it("se muestra como porcentaje, no como monto", () => {
    expect(formatGoalValue("close_rate", 25)).toBe("25%");
  });

  it("el schema rechaza capturar meta de % de cierre o de cotizaciones", () => {
    const base = { subject: "advisor", advisorMembershipId: "11111111-1111-4111-8111-111111111111", isActive: true };
    for (const metric of ["close_rate", "quotes"]) {
      const r = goalInputSchema.safeParse({ ...base, metric, targetValue: 30 });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0].message).toContain("se calculan solos");
    }
    expect(goalInputSchema.safeParse({ ...base, metric: "won", targetValue: 30 }).success).toBe(true);
  });

  it("la migración 0053 amplía el CHECK y acota el objetivo a 0–100", () => {
    const dir = path.resolve(__dirname, "..", "supabase", "migrations");
    const sql = readdirSync(dir)
      .filter((f) => f.startsWith("0053_"))
      .map((f) => readFileSync(path.join(dir, f), "utf8"))
      .join("\n")
      .toLowerCase()
      .replace(/\s+/g, " ");
    expect(sql).toContain("'close_rate'");
    expect(sql).toContain("goals_close_rate_is_percent");
    expect(sql).toContain("not ilike '%organic%'");
  });
});

describe("closeRateOf (% de cierre automático, sin objetivo)", () => {
  it("100 cotizaciones y 30 pagadas = 30%", () => {
    expect(closeRateOf({ quotes: 100, quotesWon: 30 })).toEqual({ quotes: 100, quotesWon: 30, pct: 30 });
  });

  it("sin cotizaciones no hay % que medir (null, no 0%)", () => {
    expect(closeRateOf({ quotes: 0, quotesWon: 0 }).pct).toBeNull();
  });

  it("sale del mismo tally por cohorte que el dashboard", () => {
    const t = tallyAchievement(
      [],
      [quote("2026-05-11T06:00:00.000Z"), quote(null), quote(null), quote(null)],
      [wonOpp(), wonOpp()],
      A,
    );
    expect(closeRateOf(t)).toEqual({ quotes: 4, quotesWon: 1, pct: 25 });
  });
});

describe("recentMonthKeys", () => {
  afterEach(() => vi.useRealTimers());

  it("del mes en curso hacia atrás, en MX y cruzando el año", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T03:00:00.000Z")); // 31-ene 21:00 MX
    expect(recentMonthKeys(3)).toEqual(["2026-01", "2025-12", "2025-11"]);
  });
});
