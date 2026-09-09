import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  goalInputSchema,
  metricsForSubject,
  subjectNeedsAdvisor,
} from "@/lib/metas/schema";

/**
 * Meta de VENTA ORGÁNICA y el sujeto explícito de una meta (0051).
 *
 * Contexto: el sujeto se INFERÍA de `advisor_membership_id IS NULL` = equipo.
 * Ese truco alcanzaba para dos sujetos y se rompió con el tercero — la venta
 * que entra sola por la tienda online, que también va sin vendedor.
 *
 * El riesgo que estos tests protegen es que "orgánica" se confunda con "sin
 * asesor asignado". Medido en Centr: de 947 pedidos, 578 no tienen asesor
 * pero solo 287 son de la tienda online; los otros 291 son cotizaciones donde
 * el vendedor no puso su etiqueta. Usar la ausencia de asesor como criterio
 * inflaría el canal orgánico a costa de las metas individuales.
 */

describe("metricsForSubject", () => {
  it("la venta orgánica SOLO se mide en monto", () => {
    // No lleva cotización enviada ni oportunidad trabajada: quotes y won
    // marcarían cero siempre, no por falta de datos sino por definición.
    expect(metricsForSubject("organic")).toEqual(["amount"]);
  });

  it("equipo y vendedor admiten las tres métricas", () => {
    expect(metricsForSubject("team")).toHaveLength(3);
    expect(metricsForSubject("advisor")).toHaveLength(3);
  });
});

describe("subjectNeedsAdvisor", () => {
  it("solo el sujeto 'advisor' apunta a una persona", () => {
    expect(subjectNeedsAdvisor("advisor")).toBe(true);
    expect(subjectNeedsAdvisor("team")).toBe(false);
    expect(subjectNeedsAdvisor("organic")).toBe(false);
  });
});

describe("goalInputSchema", () => {
  const base = { targetValue: 1_000_000, isActive: true };

  it("acepta una meta orgánica de monto sin vendedor", () => {
    const r = goalInputSchema.safeParse({
      ...base,
      subject: "organic",
      advisorMembershipId: null,
      metric: "amount",
    });
    expect(r.success).toBe(true);
  });

  it("rechaza una meta orgánica de cotizaciones", () => {
    const r = goalInputSchema.safeParse({
      ...base,
      subject: "organic",
      advisorMembershipId: null,
      metric: "quotes",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toContain("monto");
    }
  });

  it("rechaza una meta orgánica CON vendedor (no es de nadie)", () => {
    const r = goalInputSchema.safeParse({
      ...base,
      subject: "organic",
      advisorMembershipId: "11111111-1111-4111-8111-111111111111",
      metric: "amount",
    });
    expect(r.success).toBe(false);
  });

  it("rechaza una meta de vendedor SIN vendedor", () => {
    const r = goalInputSchema.safeParse({
      ...base,
      subject: "advisor",
      advisorMembershipId: null,
      metric: "amount",
    });
    expect(r.success).toBe(false);
  });

  it("sin `subject`, lo infiere como antes (compatibilidad)", () => {
    const equipo = goalInputSchema.safeParse({
      ...base,
      advisorMembershipId: null,
      metric: "amount",
    });
    expect(equipo.success).toBe(true);
    if (equipo.success) expect(equipo.data.subject).toBe("team");

    const vendedor = goalInputSchema.safeParse({
      ...base,
      advisorMembershipId: "11111111-1111-4111-8111-111111111111",
      metric: "amount",
    });
    expect(vendedor.success).toBe(true);
    if (vendedor.success) expect(vendedor.data.subject).toBe("advisor");
  });
});

describe("contrato SQL de 0051", () => {
  const MIGRATIONS = path.resolve(__dirname, "..", "supabase", "migrations");
  const sql = readdirSync(MIGRATIONS)
    .filter((f) => /^0051_/.test(f))
    .map((f) => readFileSync(path.join(MIGRATIONS, f), "utf8"))
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ");

  it("la migración existe y define el sujeto", () => {
    expect(sql).toContain("add column if not exists subject");
  });

  it("un sujeto 'advisor' SIEMPRE lleva vendedor; equipo y orgánica NUNCA", () => {
    expect(sql).toContain("goals_subject_advisor_shape");
    expect(sql).toContain("subject = 'advisor' and advisor_membership_id is not null");
  });

  it("la venta orgánica solo admite monto (mismo invariante que el TS)", () => {
    expect(sql).toContain("goals_organic_amount_only");
    expect(sql).toContain("subject <> 'organic' or metric = 'amount'");
  });

  it("equipo y orgánica tienen índices únicos SEPARADOS", () => {
    // Sin separarlos, la meta orgánica de monto chocaría con la de equipo:
    // el índice viejo cubría "advisor_membership_id IS NULL", que ahora
    // abarca dos sujetos distintos.
    expect(sql).toContain("goals_org_team_metric_uniq");
    expect(sql).toContain("goals_org_organic_metric_uniq");
    expect(sql).toContain("where subject = 'team'");
    expect(sql).toContain("where subject = 'organic'");
  });

  it("el HISTÓRICO también separa los sujetos", () => {
    // goal_results heredaba la misma inferencia: con meta de equipo Y
    // orgánica del mismo monto, el cron mensual reventaría por unicidad.
    expect(sql).toContain("alter table public.goal_results");
    expect(sql).toContain("goal_results_org_organic_metric_month_uniq");
  });
});

describe("contrato: 'orgánica' se define por origen del pedido, NO por ausencia de asesor", () => {
  it("el servicio filtra por orders.source, no por assigned_advisor_id", () => {
    const src = readFileSync(
      path.resolve(__dirname, "..", "lib", "services", "dashboard-metrics.ts"),
      "utf8",
    );
    const start = src.indexOf("function tallyOrganic");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = src.slice(start, src.indexOf("}", src.indexOf("return", start)));
    expect(
      body.includes("ONLINE_ORDER_SOURCE"),
      "la venta orgánica debe medirse por orders.source",
    ).toBe(true);
    expect(
      body.includes("assigned_advisor_id"),
      "NO debe usar la ausencia de asesor como criterio: mezcla la venta del " +
        "vendedor que no puso su etiqueta (291 de 578 pedidos sin asesor en Centr).",
    ).toBe(false);
  });
});
