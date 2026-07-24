import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  computeStageAutomation,
  VENTA_AUTOMATION_STAGE_NAMES,
  POSTVENTA_ENGINE_ZONE_NAMES,
  POSTVENTA_PROBLEMATIC_STAGE_NAME,
  type RuleStageReference,
} from "@/lib/services/stage-automation";
import type { Funnel, PipelineStageRow } from "@/lib/types/database";

function stage(
  id: string,
  name: string,
  position: number,
  funnel: Funnel = "venta",
  flags: Partial<PipelineStageRow> = {},
): PipelineStageRow {
  return {
    id,
    organization_id: "org-1",
    funnel,
    name,
    position,
    color: "#94A3B8",
    default_probability: null,
    is_initial: false,
    is_won: false,
    is_lost: false,
    requires_loss_reason: false,
    is_active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...flags,
  };
}

// Funnel Venta canónico (9 etapas resumidas a lo relevante).
const V_LEAD = stage("v-lead", "Lead nuevo", 1, "venta", { is_initial: true });
const V_CONTACTADO = stage("v-cont", "Contactado asesor", 2, "venta");
const V_CALIF = stage("v-cal", "Contacto calificado", 3, "venta");
const V_COTIZ = stage("v-cot", "Cotización", 6, "venta");
const V_GANADA = stage("v-won", "Ganada", 8, "venta", { is_won: true });
const V_PERDIDA = stage("v-lost", "Perdida", 9, "venta", { is_lost: true });
const VENTA = [V_LEAD, V_CONTACTADO, V_CALIF, V_COTIZ, V_GANADA, V_PERDIDA];

// Funnel Post-venta canónico.
const P_COTIZ_COMPL = stage("p-1", "Cotización completada", 1, "post_venta", { is_initial: true });
const P_PAGO = stage("p-2", "Pago confirmado", 2, "post_venta");
const P_ENVIO = stage("p-3", "Envío en curso", 3, "post_venta");
const P_ENTREGADO = stage("p-4", "Entregado", 4, "post_venta");
const P_PROBLEMA = stage("p-5", "Caso problemático", 5, "post_venta");
const POSTVENTA = [P_COTIZ_COMPL, P_PAGO, P_ENVIO, P_ENTREGADO, P_PROBLEMA];

// Funnel Outbound (Fase 1). Sus 3 etapas comparten POSICIÓN con las zonas del
// motor Post-venta, pero NO deben heredar su automatización (bug del fallback
// posicional cruzando funnels).
const O_CONTACTADO = stage("o-1", "Cliente contactado", 1, "outbound", { is_initial: true });
const O_REVISION = stage("o-2", "Revisión agendada", 2, "outbound");
const O_CALIF = stage("o-3", "Cliente calificado", 3, "outbound");
const OUTBOUND = [O_CONTACTADO, O_REVISION, O_CALIF];

describe("computeStageAutomation — flags estructurales", () => {
  it("marca is_initial de venta (auto-creación C2)", () => {
    const r = computeStageAutomation(V_LEAD, VENTA);
    expect(r.linked).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/auto-creación/i);
  });

  it("marca is_won (dispara cierre + win rate)", () => {
    const r = computeStageAutomation(V_GANADA, VENTA);
    expect(r.linked).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/Ganada/);
  });

  it("marca is_lost", () => {
    const r = computeStageAutomation(V_PERDIDA, VENTA);
    expect(r.linked).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/Perdida/);
  });
});

describe("computeStageAutomation — nombres canónicos", () => {
  it("marca 'Cotización' de venta (webhook draft_orders/create)", () => {
    const r = computeStageAutomation(V_COTIZ, VENTA);
    expect(r.linked).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/cotizaciones/i);
  });

  it("marca 'Contacto calificado' (frontera del dashboard)", () => {
    const r = computeStageAutomation(V_CALIF, VENTA);
    expect(r.linked).toBe(true);
  });

  it("NO marca una etapa intermedia sin flag ni nombre canónico", () => {
    const r = computeStageAutomation(V_CONTACTADO, VENTA);
    expect(r.linked).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("detección de nombre es case-insensitive", () => {
    const renamed = stage("v-cot2", "cotización", 6, "venta");
    expect(computeStageAutomation(renamed, VENTA).linked).toBe(true);
  });
});

describe("computeStageAutomation — motor Post-venta", () => {
  it("marca las 4 etapas-zona por nombre", () => {
    for (const s of [P_COTIZ_COMPL, P_PAGO, P_ENVIO, P_ENTREGADO]) {
      expect(computeStageAutomation(s, POSTVENTA).linked).toBe(true);
    }
  });

  it("marca la zona por POSICIÓN aunque la renombren (fallback posicional del motor)", () => {
    const renamed = stage("p-2b", "Nombre arbitrario", 2, "post_venta");
    const list = [P_COTIZ_COMPL, renamed, P_ENVIO, P_ENTREGADO, P_PROBLEMA];
    const r = computeStageAutomation(renamed, list);
    expect(r.linked).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/motor automático de Post-venta/i);
  });

  it("marca 'Caso problemático' (sumidero del motor)", () => {
    const r = computeStageAutomation(P_PROBLEMA, POSTVENTA);
    expect(r.linked).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/Sumidero/i);
  });
});

describe("computeStageAutomation — funnel Outbound NO hereda Post-venta", () => {
  it("las etapas NO finales de Outbound no se marcan ligadas (no heredan Post-venta)", () => {
    for (const s of [O_CONTACTADO, O_REVISION]) {
      const r = computeStageAutomation(s, OUTBOUND);
      expect(r.linked).toBe(false);
      expect(r.reasons).toEqual([]);
    }
  });

  it("'Revisión agendada' (pos 2) NO hereda la zona 'Pago confirmado' del motor Post-venta", () => {
    const r = computeStageAutomation(O_REVISION, OUTBOUND);
    expect(r.reasons.join(" ")).not.toMatch(/motor automático de Post-venta/i);
  });

  it("'Cliente calificado' (última) NO hereda el sumidero de cancelaciones/reembolsos", () => {
    const r = computeStageAutomation(O_CALIF, OUTBOUND);
    expect(r.reasons.join(" ")).not.toMatch(/Sumidero/i);
  });

  it("'Cliente contactado' (is_initial de Outbound) NO hereda el destino F1→F2 del Post-venta", () => {
    const r = computeStageAutomation(O_CONTACTADO, OUTBOUND);
    expect(r.reasons.join(" ")).not.toMatch(/F1→F2/);
    expect(r.linked).toBe(false);
  });

  it("la ÚLTIMA etapa de Outbound SÍ se marca: es la etapa de entrega al vendedor (F3)", () => {
    const r = computeStageAutomation(O_CALIF, OUTBOUND);
    expect(r.linked).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/se entrega la oportunidad a un vendedor/i);
  });

  it("la etapa de entrega se resuelve por POSICIÓN (rename-safe), no por nombre", () => {
    const renamed = stage("o-3b", "Nombre arbitrario", 3, "outbound");
    const list = [O_CONTACTADO, O_REVISION, renamed];
    expect(computeStageAutomation(renamed, list).linked).toBe(true);
  });

  it("el fallback posicional del Post-venta SIGUE intacto (no lo rompió el scoping por funnel)", () => {
    const renamed = stage("p-2b", "Nombre arbitrario", 2, "post_venta");
    const list = [P_COTIZ_COMPL, renamed, P_ENVIO, P_ENTREGADO, P_PROBLEMA];
    expect(computeStageAutomation(renamed, list).linked).toBe(true);
  });
});

describe("computeStageAutomation — reglas activas del admin", () => {
  it("marca una etapa referenciada por una regla activa (por nombre)", () => {
    const refs: RuleStageReference[] = [
      { stageName: "Contactado asesor", ruleLabel: "Seguimiento 24h" },
    ];
    const r = computeStageAutomation(V_CONTACTADO, VENTA, refs);
    expect(r.linked).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/Seguimiento 24h/);
  });

  it("no duplica el mismo label de regla", () => {
    const refs: RuleStageReference[] = [
      { stageName: "Contactado asesor", ruleLabel: "R" },
      { stageName: "Contactado asesor", ruleLabel: "R" },
    ];
    const r = computeStageAutomation(V_CONTACTADO, VENTA, refs);
    const hits = r.reasons.filter((x) => x.includes("«R»"));
    expect(hits).toHaveLength(1);
  });
});

/**
 * Guard estático: los nombres canónicos de este módulo deben coincidir
 * con los que los motores resuelven por nombre en su propio código. Si
 * alguien cambia un string en un lado sin el otro, el detector de
 * automatizaciones deja de proteger esa etapa — CI lo atrapa aquí.
 */
describe("contrato de nombres canónicos vs. motores", () => {
  const root = join(__dirname, "..");
  const read = (p: string) => readFileSync(join(root, p), "utf8");

  it("'Cotización' coincide con el worker de draft orders", () => {
    const src = read("lib/inngest/functions/draft-orders.ts");
    expect(src).toContain(`"${VENTA_AUTOMATION_STAGE_NAMES.cotizacion}"`);
  });

  it("las 4 zonas coinciden con postventa-transition.ts", () => {
    const src = read("lib/services/postventa-transition.ts");
    for (const name of POSTVENTA_ENGINE_ZONE_NAMES) {
      expect(src).toContain(`"${name}"`);
    }
    expect(src).toContain(`"${POSTVENTA_PROBLEMATIC_STAGE_NAME}"`);
  });

  it("'Contacto calificado' coincide con dashboard-stages.ts", () => {
    const src = read("lib/services/dashboard-stages.ts");
    expect(src).toContain(`"${VENTA_AUTOMATION_STAGE_NAMES.calificado}"`);
  });
});
