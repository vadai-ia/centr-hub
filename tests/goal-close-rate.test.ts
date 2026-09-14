import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { tallyAchievement } from "@/lib/services/dashboard-metrics";
import { achievedForMetric } from "@/lib/metas/achievement";
import { formatGoalValue, goalInputSchema, metricsForSubject } from "@/lib/metas/schema";

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

  it("la venta orgánica no la admite (no tiene cotizaciones)", () => {
    expect(metricsForSubject("organic")).not.toContain("close_rate");
    expect(metricsForSubject("advisor")).toContain("close_rate");
  });

  it("se muestra como porcentaje, no como monto", () => {
    expect(formatGoalValue("close_rate", 25)).toBe("25%");
  });

  it("el objetivo no puede pasar de 100", () => {
    const base = { subject: "advisor", advisorMembershipId: "11111111-1111-4111-8111-111111111111", isActive: true };
    expect(goalInputSchema.safeParse({ ...base, metric: "close_rate", targetValue: 30 }).success).toBe(true);
    expect(goalInputSchema.safeParse({ ...base, metric: "close_rate", targetValue: 130 }).success).toBe(false);
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
