import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { getOpportunityById } from "@/lib/db/opportunities";
import { getOrganizationById } from "@/lib/db/organizations";
import { findOrderByShopifyOrderId } from "@/lib/db/orders";
import { listPipelineStages } from "@/lib/db/pipeline";
import { moveOpportunityStage } from "@/lib/services/pipeline-move";
import {
  evaluatePostventaTarget,
  type PostventaZonePosition,
} from "@/lib/services/postventa-engine";
import type { PipelineStageRow, UUID } from "@/lib/types/database";

/**
 * Motor de transiciones automáticas de Post-venta — driver (M3v2, Bloque B).
 *
 * Toma una oportunidad de Post-venta YA EXISTENTE (el trigger F1→F2 la
 * crea en "Cotización completada"; el motor no la mete al funnel) y la
 * mueve a la etapa que corresponde al estado de su pedido en Shopify,
 * leyendo la fila `orders` ya persistida (no el payload → hereda LWW).
 *
 * Reglas de convivencia (aprobadas M3v2):
 *  - AVANCE (a etapas 1-4 de pago/preparación): solo si la opp está HOY en
 *    la zona automática (una de esas 4 etapas). Si un vendedor la movió a
 *    Seguimiento / Caso cerrado (pos 5-6), el motor NO la arrastra de
 *    vuelta — handoff al ciclo manual.
 *  - PROBLEM-EXIT (→ Caso problemático por cancelado/reembolsado): se
 *    dispara desde CUALQUIER etapa activa que no sea ya Caso problemático.
 *    Un reembolso merece revisión sin importar dónde esté la opp.
 *  - "Caso problemático" es un SUMIDERO del motor: nunca es origen de
 *    avance ni de problem-exit. Por eso una opp resuelta+archivada (que
 *    vive ahí, Bloque E) queda intocada por estas reglas sin necesidad de
 *    chequear `resolved_at` aquí.
 *
 * Idempotencia: solo mueve si la etapa actual difiere de la destino
 * (`moveOpportunityStage` además es no-op si ya está ahí). Atribución
 * intacta: `moveOpportunityStage` nunca toca `assigned_advisor_id`.
 * Carrera con movimiento manual: el optimistic-lock de `moveOpportunityStage`
 * devuelve `stale_version` → se omite este tick y el siguiente reintenta.
 */

// Anclas por nombre del catálogo v5.1 (seed migración 0019). Se resuelven
// por nombre UNA vez para obtener el stage_id real de la org; fallback a
// posición si el admin renombró (mismo criterio que dashboard-stages.ts).
const ZONE_STAGE_NAMES: Record<PostventaZonePosition, string> = {
  1: "Cotización completada",
  2: "Pago confirmado",
  3: "Envío en curso",
  4: "Entregado",
};
const PROBLEMATIC_STAGE_NAME = "Caso problemático";

export interface PostventaEngineStages {
  /** Las 4 etapas destino de la zona automática, indexadas por posición. */
  zoneByPosition: Record<PostventaZonePosition, PipelineStageRow>;
  /** stage_ids de la zona automática (origen válido para AVANCE). */
  zoneStageIds: Set<UUID>;
  /** Etapa "Caso problemático" (destino de problem-exit, sumidero). */
  problematicStage: PipelineStageRow;
}

/**
 * Resuelve las etapas que el motor necesita para la org del contexto.
 * Devuelve null si el funnel Post-venta no tiene la forma esperada (no
 * crashea: el motor simplemente no opera en esa org y se registra arriba).
 */
export async function resolvePostventaEngineStages(): Promise<PostventaEngineStages | null> {
  const stages = await listPipelineStages("post_venta");
  if (stages.length === 0) return null;
  // Orden por posición ascendente garantizado por listPipelineStages.
  const byPositionAsc = [...stages].sort((a, b) => a.position - b.position);

  const resolveZone = (
    pos: PostventaZonePosition,
  ): PipelineStageRow | null => {
    const byName = stages.find((s) => s.name === ZONE_STAGE_NAMES[pos]);
    if (byName) return byName;
    // Fallback posicional: la N-ésima etapa por orden (1-indexed).
    return byPositionAsc[pos - 1] ?? null;
  };

  const z1 = resolveZone(1);
  const z2 = resolveZone(2);
  const z3 = resolveZone(3);
  const z4 = resolveZone(4);
  if (!z1 || !z2 || !z3 || !z4) return null;

  const problematicStage =
    stages.find((s) => s.name === PROBLEMATIC_STAGE_NAME) ??
    // Fallback: la última etapa por posición (en el catálogo V1 es la final).
    byPositionAsc[byPositionAsc.length - 1];
  if (!problematicStage) return null;

  const zoneByPosition: Record<PostventaZonePosition, PipelineStageRow> = {
    1: z1,
    2: z2,
    3: z3,
    4: z4,
  };
  return {
    zoneByPosition,
    zoneStageIds: new Set([z1.id, z2.id, z3.id, z4.id]),
    problematicStage,
  };
}

export type ApplyTransitionResult =
  | { status: "moved"; fromStageId: UUID; toStageId: UUID; reason: string }
  | { status: "noop"; reason: string }
  | { status: "skipped"; reason: string };

export interface ApplyTransitionOptions {
  /**
   * Etapas del motor precomputadas (una vez por tick del cron) para evitar
   * releerlas por cada opp. Si se omite, se resuelven aquí.
   */
  engineStages?: PostventaEngineStages | null;
  /**
   * Estado del flag `organizations.backfill_in_progress` precomputado por
   * el caller. Si se omite, se lee de la BD. Durante el backfill de M11 el
   * motor entra en modo pasivo (igual que R12 y el sync) — sin esto, cada
   * pedido histórico importado movería su opp de forma sintética.
   */
  backfillInProgress?: boolean;
}

/**
 * Evalúa y (si corresponde) mueve UNA oportunidad de Post-venta según el
 * estado de su pedido. Idempotente y seguro de re-ejecutar.
 */
export async function applyPostventaTransition(
  opportunityId: UUID,
  opts: ApplyTransitionOptions = {},
): Promise<ApplyTransitionResult> {
  const backfill =
    opts.backfillInProgress ?? (await isOrgBackfillInProgress());
  if (backfill) {
    return { status: "skipped", reason: "backfill_in_progress" };
  }

  const opp = await getOpportunityById(opportunityId);
  if (!opp) return { status: "skipped", reason: "opportunity_not_found" };
  if (opp.funnel !== "post_venta") {
    return { status: "skipped", reason: "not_post_venta" };
  }
  if (opp.cancelled_at) {
    // Una opp cancelada administrativamente está fuera del pipeline activo.
    return { status: "skipped", reason: "opportunity_cancelled" };
  }

  const stages = opts.engineStages ?? (await resolvePostventaEngineStages());
  if (!stages) {
    return { status: "skipped", reason: "engine_stages_unavailable" };
  }

  // Sumidero: si ya está en Caso problemático, el motor no la toca (ni
  // avanza ni re-evalúa). El cierre lo hace una persona (Bloque E).
  if (opp.stage_id === stages.problematicStage.id) {
    return { status: "noop", reason: "already_problematic_sink" };
  }

  if (!opp.shopify_order_id) {
    // La hija de Post-venta espeja shopify_order_id (heredado del padre,
    // migración 0021). Sin él no hay pedido del cual leer estado.
    return { status: "skipped", reason: "no_shopify_order_id" };
  }
  const order = await findOrderByShopifyOrderId(opp.shopify_order_id);
  if (!order) {
    return { status: "skipped", reason: "order_not_found" };
  }

  const decision = decidePostventaStageMove(opp, order, stages);
  if (decision.kind === "noop") {
    return { status: "noop", reason: decision.reason };
  }

  const move = await moveOpportunityStage({
    opportunityId: opp.id,
    toStageId: decision.toStage.id,
    expectedLastModifiedAt: opp.last_modified_at,
    actorUserId: null,
    context: "automation",
  });

  if (move.ok) {
    return {
      status: "moved",
      fromStageId: decision.fromStageId,
      toStageId: decision.toStage.id,
      reason: decision.reason,
    };
  }
  // stale_version: otro proceso movió la opp entre la lectura y el update.
  // No es error — el siguiente tick (cron) o webhook reintenta con la
  // versión fresca. Cualquier otro fallo también se omite no-fatalmente.
  return { status: "skipped", reason: `move_failed:${move.reason}` };
}

export type PostventaDecision =
  | { kind: "move"; fromStageId: UUID; toStage: PipelineStageRow; reason: string }
  | { kind: "noop"; reason: string };

/**
 * Decisión PURA de a qué etapa mover (o no) una opp de Post-venta, dado su
 * estado de etapa actual, el snapshot de su pedido y las etapas del motor.
 *
 * Núcleo COMPARTIDO entre el driver real (`applyPostventaTransition`) y el
 * preview de dry-run (`scripts/postventa/preview-transitions.ts`): así el
 * "qué haría" del preview es BIT-A-BIT lo que el run real ejecuta — sin
 * lógica duplicada que pueda derivar. No lee BD ni mueve nada.
 */
export function decidePostventaStageMove(
  opp: { stage_id: UUID },
  order: {
    financial_status: string;
    fulfillment_status: string | null;
    delivery_status: string | null;
    cancelled_at: string | null;
  },
  stages: PostventaEngineStages,
): PostventaDecision {
  // Sumidero: si ya está en Caso problemático, el motor no la toca.
  if (opp.stage_id === stages.problematicStage.id) {
    return { kind: "noop", reason: "already_problematic_sink" };
  }

  const target = evaluatePostventaTarget(order);

  let toStage: PipelineStageRow;
  if (target.kind === "none") {
    // Estado inesperado de Shopify: no mover, dejar para diagnóstico.
    return { kind: "noop", reason: `no_target:${target.reason}` };
  } else if (target.kind === "problem") {
    // Problem-exit: one-way al sumidero. EXENTO de la guarda anti-retroceso
    // (un reembolso debe mandar a Caso problemático desde cualquier etapa).
    toStage = stages.problematicStage;
  } else {
    // AVANCE: solo desde la zona automática (1-4). Si la opp ya está fuera
    // de la zona (movida manual a Seguimiento/Caso cerrado), no arrastrar.
    if (!stages.zoneStageIds.has(opp.stage_id)) {
      return { kind: "noop", reason: "advance_out_of_zone" };
    }
    // Anti-retroceso (cambio 0036): dentro de la zona el motor SOLO avanza,
    // nunca baja de posición. Al cambiar el criterio de envío/entrega de
    // preparación a entrega, una opp que el criterio viejo dejó en Entregado
    // no debe rebotar a Envío en curso ni a Pago si la señal de entrega aún
    // no llegó. Solo se mueve si la posición destino es mayor que la actual.
    // Estricto `<`: posición igual cae al check `already_in_target` de
    // abajo (idempotencia); solo bloqueamos un retroceso real (target menor).
    const currentPosition = positionOfZoneStage(opp.stage_id, stages);
    if (currentPosition !== null && target.position < currentPosition) {
      return { kind: "noop", reason: "advance_no_backward" };
    }
    toStage = stages.zoneByPosition[target.position];
  }

  if (toStage.id === opp.stage_id) {
    return { kind: "noop", reason: "already_in_target" };
  }

  return { kind: "move", fromStageId: opp.stage_id, toStage, reason: target.reason };
}

/** Posición (1-4) de la etapa de zona cuyo id coincide, o null si no es de zona. */
function positionOfZoneStage(
  stageId: UUID,
  stages: PostventaEngineStages,
): PostventaZonePosition | null {
  const positions: PostventaZonePosition[] = [1, 2, 3, 4];
  for (const pos of positions) {
    if (stages.zoneByPosition[pos].id === stageId) return pos;
  }
  return null;
}

/**
 * Kill switch del motor automático (M3v2). Gatea los DOS puntos de entrada
 * automáticos — el cron horario y el hook inline de orders — para que el
 * primer backfill histórico NO corra en producción hasta que el operador
 * lo habilite tras revisar el dry-run (`maintenance:preview-postventa-
 * transitions`). Default OFF: sin `POSTVENTA_ENGINE_ENABLED=true` en el
 * entorno, el motor no mueve nada.
 *
 * NO gatea: (a) el preview dry-run (read-only, usa `decidePostventaStageMove`
 * directo); (b) el cierre manual de casos (`resolvePostventaCase`, acción de
 * admin/asesor). Solo el movimiento AUTOMÁTICO de etapa.
 */
export function isPostventaEngineEnabled(): boolean {
  return process.env.POSTVENTA_ENGINE_ENABLED === "true";
}

/** Lee `organizations.backfill_in_progress` de la org del contexto. */
export async function isOrgBackfillInProgress(): Promise<boolean> {
  const { organizationId } = getTenantScopedClient();
  const org = await getOrganizationById(organizationId);
  return Boolean(
    org && (org as unknown as { backfill_in_progress?: boolean }).backfill_in_progress,
  );
}
