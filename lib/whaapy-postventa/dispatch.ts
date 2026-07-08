import "server-only";
import {
  getInngestClient,
  WHAAPY_POSTVENTA_STAGE_PUSH_EVENT,
  type WhaapyPostventaStagePushEnvelope,
} from "@/lib/inngest/client";
import { isPostventaWhaapySyncEnabled } from "@/lib/whaapy-postventa/config";
import type { PipelineStageRow, UUID } from "@/lib/types/database";

/**
 * Encolado de los PUSH de etapa al Whaapy de Post-venta (webhooks 1, 2, 4).
 *
 * Reglas transversales a los tres hooks:
 *   - GATE por kill switch: si OFF, no se encola nada (cero overhead).
 *   - NON-FATAL: cualquier fallo del enqueue se traga (stderr) — el cambio
 *     de etapa/resolución de la opp NUNCA se rompe por la propagación.
 *   - El worker vuelve a chequear kill switch + backfill; acá solo evitamos
 *     encolar de más.
 */

async function enqueue(
  envelope: WhaapyPostventaStagePushEnvelope,
): Promise<void> {
  if (!isPostventaWhaapySyncEnabled()) return;
  try {
    await getInngestClient().send({
      name: WHAAPY_POSTVENTA_STAGE_PUSH_EVENT,
      data: envelope as unknown as Record<string, unknown>,
    });
  } catch (err) {
    // Non-fatal: la operación primaria (mover/resolver la opp) ya ocurrió.
    console.error(
      `[whaapy-postventa] enqueue falló (opp ${envelope.opportunityId}, target ${envelope.target}):`,
      (err as Error).message,
    );
  }
}

/**
 * Hook de `moveOpportunityStage`: si el destino es Entregado o Caso
 * Problemático del funnel Post-venta, encola el push correspondiente.
 * Cubre AMBAS vías del move (motor automático + drag manual).
 *
 * Import dinámico de `resolvePostventaEngineStages` para NO crear un ciclo
 * estático (pipeline-move → dispatch → postventa-transition → pipeline-move).
 */
export async function dispatchPostventaPushForMove(args: {
  organizationId: UUID;
  opportunityId: UUID;
  targetStage: PipelineStageRow;
}): Promise<void> {
  if (!isPostventaWhaapySyncEnabled()) return;
  if (args.targetStage.funnel !== "post_venta") return;
  try {
    const { resolvePostventaEngineStages } = await import(
      "@/lib/services/postventa-transition"
    );
    const stages = await resolvePostventaEngineStages();
    if (!stages) return;

    const entregado = stages.zoneByPosition[4];
    let target: WhaapyPostventaStagePushEnvelope["target"] | null = null;
    if (entregado && args.targetStage.id === entregado.id) {
      target = "entregado";
    } else if (args.targetStage.id === stages.problematicStage.id) {
      target = "casoProblematico";
    }
    if (!target) return;

    await enqueue({
      organizationId: args.organizationId,
      opportunityId: args.opportunityId,
      target,
      reason: `move:${target}`,
    });
  } catch (err) {
    console.error(
      `[whaapy-postventa] clasificación de move falló (opp ${args.opportunityId}):`,
      (err as Error).message,
    );
  }
}

/**
 * Hook de `reopenOpportunityIntoProblemCase`: la opp reabierta SIEMPRE
 * aterriza en Caso Problemático → push fijo. Cubre botón "+", drag de
 * reapertura y reapertura de M4v2.
 */
export async function dispatchPostventaPushForReopen(args: {
  organizationId: UUID;
  opportunityId: UUID;
}): Promise<void> {
  await enqueue({
    organizationId: args.organizationId,
    opportunityId: args.opportunityId,
    target: "casoProblematico",
    reason: "reopen",
  });
}

/**
 * Hook de `resolvePostventaCase` (webhook 4): push fijo a Caso Resuelto.
 * ANTI-BUCLE capa 1: SOLO se invoca cuando la resolución se origina en la
 * PLATAFORMA. El worker del webhook 3 (resolución venida de Whaapy) NO
 * llama esto, así un archivado originado por Whaapy no rebota de vuelta.
 */
export async function dispatchPostventaPushForResolve(args: {
  organizationId: UUID;
  opportunityId: UUID;
}): Promise<void> {
  await enqueue({
    organizationId: args.organizationId,
    opportunityId: args.opportunityId,
    target: "casoResuelto",
    reason: "resolve_platform",
  });
}
