import { describe, expect, it } from "vitest";
import {
  computeLeadFunnel,
  type FunnelHistoryEntry,
  type FunnelStageDef,
} from "@/lib/services/lead-funnel";

/**
 * Embudo de leads (punto 9). Módulo puro.
 *
 * Las etapas replican el catálogo REAL de Centr, incluido el detalle que
 * rompe la versión ingenua: "Cold" vive en la posición 10, DESPUÉS de
 * "Ganada" (9), y no está marcada como perdida.
 */

const STAGES: FunnelStageDef[] = [
  { id: "s1", name: "Lead nuevo", position: 1, isWon: false, isLost: false },
  { id: "s2", name: "Contactado asesor", position: 2, isWon: false, isLost: false },
  { id: "s3", name: "Contacto calificado", position: 3, isWon: false, isLost: false },
  { id: "s6", name: "Cotización", position: 6, isWon: false, isLost: false },
  { id: "s9", name: "Ganada", position: 9, isWon: true, isLost: false },
  { id: "s10", name: "Cold", position: 10, isWon: false, isLost: false },
  { id: "s11", name: "Perdida", position: 11, isWon: false, isLost: true },
];

function h(contactId: string, stageId: string): FunnelHistoryEntry {
  return { contactId, stageId };
}

const byName = (funnel: ReturnType<typeof computeLeadFunnel>, name: string) =>
  funnel.steps.find((s) => s.stageName === name);

describe("computeLeadFunnel — los pasos del embudo", () => {
  it("deja fuera la etapa perdida y los sumideros posteriores al cierre", () => {
    const f = computeLeadFunnel({
      cohortContacts: ["c1"],
      leadOpportunityCount: 1,
      history: [h("c1", "s1")],
      stages: STAGES,
    });
    expect(f.steps.map((s) => s.stageName)).toEqual([
      "Lead nuevo",
      "Contactado asesor",
      "Contacto calificado",
      "Cotización",
      "Ganada",
    ]);
  });

  it("los pasos salen ordenados por posición, no por el orden de entrada", () => {
    const f = computeLeadFunnel({
      cohortContacts: ["c1"],
      leadOpportunityCount: 1,
      history: [],
      stages: [...STAGES].reverse(),
    });
    expect(f.steps.map((s) => s.position)).toEqual([1, 2, 3, 6, 9]);
  });
});

describe("computeLeadFunnel — es monotónico", () => {
  it('"llegó al menos hasta aquí": un salto cuenta en los pasos intermedios', () => {
    // Caso real: el webhook de un Draft Order manda la tarjeta de Lead nuevo
    // directo a Cotización. Contar solo las etapas registradas dejaría
    // agujeros en "Contactado" y "Calificado".
    const f = computeLeadFunnel({
      cohortContacts: ["c1"],
      leadOpportunityCount: 1,
      history: [h("c1", "s1"), h("c1", "s6")],
      stages: STAGES,
    });
    expect(byName(f, "Contactado asesor")?.reached).toBe(1);
    expect(byName(f, "Contacto calificado")?.reached).toBe(1);
    expect(byName(f, "Cotización")?.reached).toBe(1);
    expect(byName(f, "Ganada")?.reached).toBe(0);
  });

  it("volver atrás no borra lo alcanzado", () => {
    const f = computeLeadFunnel({
      cohortContacts: ["c1"],
      leadOpportunityCount: 1,
      history: [h("c1", "s1"), h("c1", "s6"), h("c1", "s2")],
      stages: STAGES,
    });
    expect(byName(f, "Cotización")?.reached).toBe(1);
  });

  it("un lead sin historial recuperable se queda en el tope, no desaparece", () => {
    const f = computeLeadFunnel({
      cohortContacts: ["c1"],
      leadOpportunityCount: 1,
      history: [],
      stages: STAGES,
    });
    expect(byName(f, "Lead nuevo")?.reached).toBe(1);
    expect(byName(f, "Contactado asesor")?.reached).toBe(0);
  });
});

describe("computeLeadFunnel — el sumidero posterior al cierre no es avance", () => {
  it("quien cae en Cold NO cuenta como ganado", () => {
    // Este es el bug que el corte evita: Cold está en la posición 10, mayor
    // que la de Ganada (9), así que el máximo monotónico la contaría como
    // cerrada. Medido en producción: "Ganada" marcaba 19 cuando eran 17.
    const f = computeLeadFunnel({
      cohortContacts: ["c1"],
      leadOpportunityCount: 1,
      history: [h("c1", "s1"), h("c1", "s3"), h("c1", "s10")],
      stages: STAGES,
    });
    expect(byName(f, "Ganada")?.reached).toBe(0);
    expect(byName(f, "Cotización")?.reached).toBe(0);
    // Lo que sí alcanzó se conserva.
    expect(byName(f, "Contacto calificado")?.reached).toBe(1);
    expect(f.parked).toBe(1);
  });

  it("pasar por Cold después de ganar no quita la ganada", () => {
    const f = computeLeadFunnel({
      cohortContacts: ["c1"],
      leadOpportunityCount: 1,
      history: [h("c1", "s1"), h("c1", "s9"), h("c1", "s10")],
      stages: STAGES,
    });
    expect(byName(f, "Ganada")?.reached).toBe(1);
    expect(f.parked).toBe(1);
  });

  it("la etapa perdida tampoco cuenta como avance", () => {
    const f = computeLeadFunnel({
      cohortContacts: ["c1"],
      leadOpportunityCount: 1,
      history: [h("c1", "s1"), h("c1", "s11")],
      stages: STAGES,
    });
    expect(byName(f, "Contactado asesor")?.reached).toBe(0);
    expect(f.parked).toBe(0);
  });

  it("sin etapa ganada marcada, no hay corte y todo paso no-perdido cuenta", () => {
    // Una organización que renombró o borró su etapa ganada no debe acabar
    // con un embudo vacío.
    const sinWon = STAGES.map((s) => ({ ...s, isWon: false }));
    const f = computeLeadFunnel({
      cohortContacts: ["c1"],
      leadOpportunityCount: 1,
      history: [h("c1", "s10")],
      stages: sinWon,
    });
    expect(f.steps.map((s) => s.stageName)).toContain("Cold");
    expect(byName(f, "Cold")?.reached).toBe(1);
  });
});

describe("computeLeadFunnel — la cohorte es de PERSONAS", () => {
  it("el viaje partido en dos oportunidades se lee como uno", () => {
    // El lead vive en una opp (archivada por absorción) y la venta se cierra
    // en la de la cotización. Por persona, el historial de ambas suma.
    const f = computeLeadFunnel({
      cohortContacts: ["c1"],
      leadOpportunityCount: 1,
      history: [h("c1", "s1"), h("c1", "s6"), h("c1", "s9")],
      stages: STAGES,
    });
    expect(byName(f, "Ganada")?.reached).toBe(1);
  });

  it("una persona que entró dos veces como lead cuenta UNA vez", () => {
    const f = computeLeadFunnel({
      cohortContacts: ["c1", "c1", "c2"],
      leadOpportunityCount: 3,
      history: [h("c1", "s1"), h("c2", "s1")],
      stages: STAGES,
    });
    expect(f.cohortSize).toBe(2);
    expect(byName(f, "Lead nuevo")?.reached).toBe(2);
    // El conteo de oportunidades se conserva para poder explicar la brecha.
    expect(f.leadOpportunities).toBe(3);
  });

  it("el historial de alguien FUERA de la cohorte se ignora", () => {
    // El historial se trae sin filtro de asesor; el scope se aplica a la
    // cohorte. Sin esta guarda, el embudo de un vendedor mostraría el avance
    // de personas que no son suyas.
    const f = computeLeadFunnel({
      cohortContacts: ["c1"],
      leadOpportunityCount: 1,
      history: [h("c1", "s1"), h("c2", "s9")],
      stages: STAGES,
    });
    expect(byName(f, "Ganada")?.reached).toBe(0);
    expect(f.cohortSize).toBe(1);
  });
});

describe("computeLeadFunnel — porcentajes", () => {
  it("son FRACCIONES 0–1, como el resto del dashboard", () => {
    const f = computeLeadFunnel({
      cohortContacts: ["c1", "c2", "c3", "c4"],
      leadOpportunityCount: 4,
      history: [
        h("c1", "s1"), h("c2", "s1"), h("c3", "s1"), h("c4", "s1"),
        h("c1", "s3"), h("c2", "s3"),
        h("c1", "s9"),
      ],
      stages: STAGES,
    });
    expect(byName(f, "Lead nuevo")?.shareOfLeads).toBe(1);
    expect(byName(f, "Contacto calificado")?.shareOfLeads).toBe(0.5);
    expect(byName(f, "Ganada")?.shareOfLeads).toBe(0.25);
  });

  it("la conversión de paso es contra el paso ANTERIOR, no contra el tope", () => {
    const f = computeLeadFunnel({
      cohortContacts: ["c1", "c2", "c3", "c4"],
      leadOpportunityCount: 4,
      history: [
        h("c1", "s1"), h("c2", "s1"), h("c3", "s1"), h("c4", "s1"),
        h("c1", "s3"), h("c2", "s3"),
        h("c1", "s9"),
      ],
      stages: STAGES,
    });
    expect(byName(f, "Lead nuevo")?.stepConversion).toBeNull();
    // 2 de los 4 leads llegaron a "Contactado" → 50%. De esos 2, los mismos 2
    // alcanzaron "Calificado" (nadie se cayó en medio) → 100%. Y de esos 2,
    // solo 1 llegó a Cotización → 50%. Que un paso marque 100% es información:
    // ahí no se pierde nadie.
    expect(byName(f, "Contactado asesor")?.stepConversion).toBe(0.5);
    expect(byName(f, "Contacto calificado")?.stepConversion).toBe(1);
    expect(byName(f, "Cotización")?.stepConversion).toBe(0.5);
  });

  it("sin cohorte no hay división por cero: todo null y cero", () => {
    const f = computeLeadFunnel({
      cohortContacts: [],
      leadOpportunityCount: 0,
      history: [h("c1", "s9")],
      stages: STAGES,
    });
    expect(f.cohortSize).toBe(0);
    expect(f.steps).toHaveLength(5);
    expect(f.steps.every((s) => s.reached === 0 && s.shareOfLeads === null)).toBe(true);
    expect(f.parked).toBe(0);
  });
});
