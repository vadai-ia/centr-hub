import "server-only";
import { listPipelineStages } from "@/lib/db/pipeline";
import type { PipelineStageRow, UUID } from "@/lib/types/database";

/**
 * Resolución de fronteras de etapa para el Dashboard (M8.2).
 *
 * Regla del proyecto: "pre-Cotización" y "Cotización en adelante" se
 * resuelven por POSICIÓN de etapa real de la org, no por listas de
 * nombres hardcodeadas (mismo criterio que la absorción de M7.2). Las
 * etapas son editables/reordenables por el admin (M7.2 B3).
 *
 * Anclas: como NO existe un flag estructural tipo `is_quote`, se ancla
 * por nombre UNA sola vez para obtener la POSICIÓN de las dos fronteras
 * semánticas ("Cotización" y "Contacto calificado") — exactamente como
 * el worker de draft orders ya resuelve "Cotización"
 * (draft-orders.ts). A partir de la posición, TODA clasificación se
 * hace comparando `position`, nunca nombres. Si el ancla por nombre no
 * existe (renombrada), hay fallback posicional documentado.
 */

const COTIZACION_STAGE_NAME = "Cotización";
const QUALIFIED_STAGE_NAME = "Contacto calificado";

export interface VentaStageBoundaries {
  stages: PipelineStageRow[];
  /** Posición de la etapa "Cotización" (frontera lead → oportunidad). */
  cotizacionPosition: number;
  /** Posición de la etapa "Contacto calificado" (inicio banda calificada). */
  qualifiedPosition: number;
  initialStage: PipelineStageRow | null;
  wonStage: PipelineStageRow | null;
  lostStage: PipelineStageRow | null;
  /** IDs de etapas pre-Cotización en la banda calificada: [calificado .. cotización-1]. */
  qualifiedBandStageIds: UUID[];
  byId: Map<UUID, PipelineStageRow>;
}

export async function resolveVentaStageBoundaries(): Promise<VentaStageBoundaries> {
  const stages = await listPipelineStages("venta");
  const byId = new Map(stages.map((s) => [s.id, s]));

  const initialStage = stages.find((s) => s.is_initial) ?? null;
  const wonStage = stages.find((s) => s.is_won) ?? null;
  const lostStage = stages.find((s) => s.is_lost) ?? null;

  const cotizacion = stages.find((s) => s.name === COTIZACION_STAGE_NAME);
  // Fallback: si "Cotización" fue renombrada, usa la posición anterior a
  // la etapa ganada como aproximación de la frontera (las etapas de
  // negociación con draft viven justo antes del cierre). Si tampoco hay
  // won, cae a la mediana del funnel.
  const cotizacionPosition =
    cotizacion?.position ??
    (wonStage ? Math.max(1, wonStage.position - 2) : medianPosition(stages));

  const qualified = stages.find((s) => s.name === QUALIFIED_STAGE_NAME);
  // Fallback: tercera etapa (initial + 2) — Lead nuevo(1) → Contactado(2)
  // → Contacto calificado(3) en el catálogo v5.1.
  const qualifiedPosition =
    qualified?.position ??
    (initialStage ? initialStage.position + 2 : 3);

  const qualifiedBandStageIds = stages
    .filter(
      (s) => s.position >= qualifiedPosition && s.position < cotizacionPosition,
    )
    .map((s) => s.id);

  return {
    stages,
    cotizacionPosition,
    qualifiedPosition,
    initialStage,
    wonStage,
    lostStage,
    qualifiedBandStageIds,
    byId,
  };
}

function medianPosition(stages: PipelineStageRow[]): number {
  if (stages.length === 0) return 1;
  const sorted = [...stages].map((s) => s.position).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const PROBLEMATIC_STAGE_NAME = "Caso problemático";

/**
 * Resuelve la etapa "Caso problemático" del Funnel Post-venta. Ancla
 * por nombre; fallback a la última etapa por posición (en el catálogo
 * V1 "Caso problemático" es la etapa final del post-venta).
 */
export async function resolveProblematicStage(): Promise<PipelineStageRow | null> {
  const stages = await listPipelineStages("post_venta");
  if (stages.length === 0) return null;
  const byName = stages.find((s) => s.name === PROBLEMATIC_STAGE_NAME);
  if (byName) return byName;
  return stages.reduce((max, s) => (s.position > max.position ? s : max), stages[0]);
}
