import type { UUID } from "@/lib/types/database";
import type { LeadFunnel, FunnelStep } from "@/lib/types/dashboard";

/**
 * Embudo de leads (punto 9 de la junta): "de los leads que entraron, cuántos
 * se calificaron, cuántos cotizaron y cuántos cerraron".
 *
 * Módulo PURO. Las tres decisiones que lo hacen correcto —y que una
 * implementación ingenua se come— están aquí:
 *
 * 1. **La cohorte es de PERSONAS, no de oportunidades.** En Centr el viaje de
 *    una persona se parte en dos filas: su lead vive en una oportunidad y la
 *    venta se cierra en OTRA (la de la cotización de Shopify), y al avanzar el
 *    lead se archiva por absorción. Un embudo por oportunidad mostraría los
 *    leads por un lado y, por otro, cotizaciones que "nacieron" ya cotizando:
 *    dos poblaciones distintas apiladas como si fueran una.
 *
 * 2. **Es MONOTÓNICO: "llegó al menos hasta aquí".** Los webhooks de Shopify
 *    saltan etapas (un Draft Order manda la tarjeta de "Lead nuevo" directo a
 *    "Cotización"), así que contar solo las etapas que el historial registra
 *    deja el embudo lleno de agujeros. Lo que un embudo mide es profundidad de
 *    avance, y eso es la posición MÁXIMA alcanzada.
 *
 * 3. **El embudo termina en la etapa ganada.** Una etapa POSTERIOR a la ganada
 *    (en Centr, "Cold" en la posición 10, después de "Ganada" en la 9) es un
 *    sumidero, no un paso más profundo. Sin este corte, quien cae en "Cold"
 *    tiene posición máxima mayor que la de "Ganada" y el monotónico lo cuenta
 *    como ganado. Medido en producción: "Ganada" marcaba 19 cuando eran 17.
 *    El corte se deriva de la bandera `isWon`, no de nombres de etapa — las
 *    posiciones y los nombres los edita el admin.
 */

export interface FunnelStageDef {
  id: UUID;
  name: string;
  position: number;
  isWon: boolean;
  isLost: boolean;
}

/** Una entrada de etapa del historial, ya atribuida a la persona. */
export interface FunnelHistoryEntry {
  contactId: UUID;
  stageId: UUID;
}

export interface ComputeLeadFunnelInput {
  /** Personas que entraron como lead en el periodo (ya filtradas por scope). */
  cohortContacts: UUID[];
  /** Oportunidades-lead del periodo: explica por qué 105 entradas son 102 personas. */
  leadOpportunityCount: number;
  /** Historial de etapas de TODAS las oportunidades de Venta de esas personas. */
  history: FunnelHistoryEntry[];
  stages: FunnelStageDef[];
}

/**
 * FRACCIÓN (0–1), no porcentaje: es la convención del dashboard
 * (`rateOrNull`) y lo que `formatPercent` espera. Devolver 0–100 aquí
 * pintaría "6300%" sin que nada truene.
 */
const ratio = (part: number, total: number): number | null =>
  total > 0 ? part / total : null;

export function computeLeadFunnel(input: ComputeLeadFunnelInput): LeadFunnel {
  const won = input.stages.find((s) => s.isWon) ?? null;
  const byId = new Map(input.stages.map((s) => [s.id, s]));

  // Los pasos del embudo: ni la etapa de perdida ni los sumideros que viven
  // DESPUÉS de la ganada.
  const steps = input.stages
    .filter((s) => !s.isLost && (won === null || s.position <= won.position))
    .sort((a, b) => a.position - b.position);

  const cohort = Array.from(new Set(input.cohortContacts));
  if (steps.length === 0 || cohort.length === 0) {
    return {
      cohortSize: cohort.length,
      leadOpportunities: input.leadOpportunityCount,
      steps: steps.map((s) => ({
        stageId: s.id,
        stageName: s.name,
        position: s.position,
        reached: 0,
        shareOfLeads: null,
        stepConversion: null,
      })),
      parked: 0,
    };
  }

  const inCohort = new Set(cohort);
  const topPosition = steps[0]!.position;
  const maxPosition = new Map<UUID, number>();
  const parked = new Set<UUID>();

  for (const h of input.history) {
    if (!inCohort.has(h.contactId)) continue;
    const stage = byId.get(h.stageId);
    if (!stage || stage.isLost) continue;
    if (won !== null && stage.position > won.position) {
      // Sumidero post-ganada ("Cold"): se anota aparte y NO cuenta como
      // avance. Si contara, su posición superaría la de la ganada.
      parked.add(h.contactId);
      continue;
    }
    const prev = maxPosition.get(h.contactId) ?? -Infinity;
    if (stage.position > prev) maxPosition.set(h.contactId, stage.position);
  }

  const reachedPerStep = steps.map((s) => {
    let n = 0;
    for (const contactId of cohort) {
      // Sin historial recuperable, la persona está en el tope del embudo: ya
      // se sabe que entró como lead, eso es lo que la puso en la cohorte.
      const max = maxPosition.get(contactId) ?? topPosition;
      if (max >= s.position) n += 1;
    }
    return n;
  });

  const outSteps: FunnelStep[] = steps.map((s, i) => ({
    stageId: s.id,
    stageName: s.name,
    position: s.position,
    reached: reachedPerStep[i]!,
    shareOfLeads: ratio(reachedPerStep[i]!, cohort.length),
    stepConversion: i === 0 ? null : ratio(reachedPerStep[i]!, reachedPerStep[i - 1]!),
  }));

  return {
    cohortSize: cohort.length,
    leadOpportunities: input.leadOpportunityCount,
    steps: outSteps,
    parked: parked.size,
  };
}
