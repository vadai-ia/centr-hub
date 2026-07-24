import type { PipelineStageRow } from "@/lib/types/database";

/**
 * Detección de "etapa ligada a automatizaciones" (fix panel admin —
 * Bloque A). Módulo PURO (sin `server-only`) para ser testeable y para
 * que el resultado calculado en el servidor viaje al cliente como data.
 *
 * Por qué existe: no hay un solo booleano `es_automatizada`. Las
 * automatizaciones resuelven sus etapas por DOS mecanismos:
 *
 *   (A) Por flag estructural (`is_initial` / `is_won` / `is_lost`) —
 *       legible directo de la fila, robusto ante rename.
 *   (B) Por NOMBRE hardcodeado con fallback posicional — NO derivable
 *       de un booleano. Renombrar una de estas etapas rompe la
 *       automatización en silencio (cae al fallback posicional o, en el
 *       motor de reglas, a `stage_not_found`).
 *
 * Este helper compone ambos + las reglas de automatización activas del
 * admin (que referencian etapas por `stage_name` en su config). El
 * conjunto de nombres canónicos vive AQUÍ como fuente única; hoy están
 * dispersos como constantes en `draft-orders.ts`, `postventa-transition.ts`,
 * `dashboard-stages.ts` y `rules-engine.ts`. Si esos nombres cambian,
 * actualizar también este módulo (los tests lo cubren).
 */

/** Etapas Funnel Venta que las automatizaciones resuelven por NOMBRE. */
export const VENTA_AUTOMATION_STAGE_NAMES = {
  /** Destino del webhook `draft_orders/create` + frontera del dashboard. */
  cotizacion: "Cotización",
  /** Banda "calificado" del dashboard. */
  calificado: "Contacto calificado",
} as const;

/**
 * Las 4 etapas-zona del motor automático de Post-venta, en orden. El
 * motor las resuelve por nombre con fallback a la posición 1..4, así
 * que las 4 primeras posiciones son load-bearing aunque el admin las
 * renombre (ver `resolvePostventaEngineStages`).
 */
export const POSTVENTA_ENGINE_ZONE_NAMES = [
  "Cotización completada",
  "Pago confirmado",
  "Envío en curso",
  "Entregado",
] as const;

/** Sumidero del motor de Post-venta + destino de reaperturas. */
export const POSTVENTA_PROBLEMATIC_STAGE_NAME = "Caso problemático";

export interface StageAutomationInfo {
  /** true si borrar/renombrar la etapa rompería alguna automatización. */
  linked: boolean;
  /** Frases legibles (español) de QUÉ automatización depende de la etapa. */
  reasons: string[];
}

/** Referencia a una etapa desde una regla de automatización activa. */
export interface RuleStageReference {
  /** `trigger_config.stage_name` / `restricted_to_stage` de la regla. */
  stageName: string;
  /** Nombre visible de la regla (para el mensaje). */
  ruleLabel: string;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Calcula la dependencia de automatizaciones de UNA etapa.
 *
 * @param stage        la etapa evaluada.
 * @param funnelStages TODAS las etapas del MISMO funnel (para resolver
 *                     posiciones del motor Post-venta).
 * @param ruleRefs     etapas referenciadas por reglas de automatización
 *                     ACTIVAS de la org (nombre + label de la regla).
 */
export function computeStageAutomation(
  stage: PipelineStageRow,
  funnelStages: PipelineStageRow[],
  ruleRefs: RuleStageReference[] = [],
): StageAutomationInfo {
  const reasons: string[] = [];

  // (A) Flags estructurales.
  if (stage.is_initial) {
    // El significado de "etapa inicial" es POR FUNNEL — NO asumir que todo lo
    // no-venta es Post-venta (Outbound también tiene su etapa inicial).
    if (stage.funnel === "venta") {
      reasons.push("Recibe la auto-creación de oportunidades nuevas (Lead nuevo / C2).");
    } else if (stage.funnel === "post_venta") {
      reasons.push("Es el destino de la oportunidad de Post-venta que crea el cierre de venta (F1→F2).");
    }
    // Outbound: la etapa inicial recibe altas manuales del SDR, pero se resuelve
    // por el flag is_initial (no por nombre) y el invariante "una inicial por
    // funnel" ya la protege — sin fragilidad por nombre → no se marca ligada.
  }
  if (stage.is_won) {
    reasons.push(
      "Etapa Ganada: dispara el cierre de venta (creación de la oportunidad de Post-venta) y alimenta el win rate.",
    );
  }
  if (stage.is_lost) {
    reasons.push("Etapa Perdida: alimenta el win rate y exige motivo de pérdida.");
  }

  // (B) Nombres canónicos por funnel.
  const name = normalizeName(stage.name);
  if (stage.funnel === "venta") {
    if (name === normalizeName(VENTA_AUTOMATION_STAGE_NAMES.cotizacion)) {
      reasons.push(
        "Destino automático de las cotizaciones que llegan de Shopify (webhook draft_orders/create).",
      );
    }
    if (name === normalizeName(VENTA_AUTOMATION_STAGE_NAMES.calificado)) {
      reasons.push('Frontera "calificado" que usa el dashboard para sus métricas.');
    }
  } else if (stage.funnel === "post_venta") {
    // Post-venta: motor automático por nombre O por posición 1..4.
    // IMPORTANTE: el fallback POSICIONAL vive DENTRO de esta rama por funnel —
    // nunca cruza funnels. Un stage de Outbound en la posición N NO hereda la
    // zona N del Post-venta (bug: antes el `else` capturaba todo lo no-venta).
    const byPositionAsc = [...funnelStages].sort((a, b) => a.position - b.position);
    const posIndex = byPositionAsc.findIndex((s) => s.id === stage.id);
    const isZoneByName = POSTVENTA_ENGINE_ZONE_NAMES.some(
      (zn) => normalizeName(zn) === name,
    );
    const isZoneByPosition = posIndex >= 0 && posIndex <= 3;
    if (isZoneByName || isZoneByPosition) {
      reasons.push(
        "Etapa del motor automático de Post-venta (avanza según el estado del pedido en Shopify).",
      );
    }
    const isLastByPosition =
      byPositionAsc.length > 0 &&
      byPositionAsc[byPositionAsc.length - 1]?.id === stage.id;
    if (name === normalizeName(POSTVENTA_PROBLEMATIC_STAGE_NAME) || isLastByPosition) {
      reasons.push(
        "Sumidero del motor de Post-venta (cancelaciones/reembolsos) y destino de reaperturas.",
      );
    }
  }

  // (C) Reglas de automatización activas que la referencian por nombre.
  const seenRuleLabels = new Set<string>();
  for (const ref of ruleRefs) {
    if (normalizeName(ref.stageName) !== name) continue;
    if (seenRuleLabels.has(ref.ruleLabel)) continue;
    seenRuleLabels.add(ref.ruleLabel);
    reasons.push(`Regla de automatización activa: «${ref.ruleLabel}».`);
  }

  return { linked: reasons.length > 0, reasons };
}
