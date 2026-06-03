import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import {
  cancelOpportunity,
  getOpportunityById,
  listOpportunities,
} from "@/lib/db/opportunities";
import { recordAuditEvent } from "@/lib/db/operational";
import type { Json, UUID } from "@/lib/types/database";

/**
 * Absorción de leads pre-Cotización cuando llega una oportunidad más
 * avanzada (típicamente la Cotización de un `draft_orders/create`).
 *
 * Regla de negocio (CLAUDE.md "Auto-creación C2 — Modelo C2 (R12)" +
 * fix post-CHECKPOINT M7.2 #4): las etapas ANTERIORES a "Cotización"
 * en el Funnel Venta son fases de lead del mismo flujo comercial
 * (Lead nuevo, Contactado asesor, Contacto calificado, etc.). La
 * coexistencia de un lead en cualquiera de esas etapas SIN draft
 * propia con una Cotización del mismo contacto NO es un estado válido
 * — el lead se absorbe. R12 cubre la dirección "no crees el Lead nuevo
 * si ya hay opp avanzada"; este servicio cubre la inversa (la avanzada
 * aterriza después por race de webhooks).
 *
 * "Anterior a Cotización" NO se hardcodea por nombre: la opp absorbente
 * (la Cotización recién creada) define el umbral con su PROPIA posición
 * de etapa. Se absorben los leads del contacto cuya etapa tiene
 * posición MENOR que la de la absorbente. Esto respeta las posiciones
 * editables por el admin (M7.2 Bloque 3).
 *
 * Mecánica:
 *   - Resuelve la posición de etapa de la opp absorbente.
 *   - Lista opps activas (no canceladas) del contacto en Funnel Venta;
 *     candidatos = etapa con posición < umbral, SIN `shopify_draft_order_id`
 *     propio (si tiene su propia draft, es otra negociación y coexiste
 *     — no se toca), excluyendo la propia absorbente.
 *   - Cancela cada match con `cancelOpportunity(source =
 *     "absorbed_by_advanced_opportunity")`. Cancelación ≠ pérdida (R5):
 *     no contamina win rate ni transita a "Perdida"; la etapa al momento
 *     de absorción queda en el row.
 *   - Audit log `lead_nuevo_absorbed_by_advanced_opportunity`.
 *
 * Idempotente: si no hay lead pre-Cotización activo sin draft, es no-op.
 * No introduce races nuevos — corre tras crear la Cotización y
 * `listOpportunities` ya excluye canceladas (los absorbidos no reaparecen).
 */

const ABSORPTION_SOURCE = "absorbed_by_advanced_opportunity" as const;

export interface AbsorbInput {
  /** Contacto cuyo Lead nuevo se quiere absorber. */
  contactId: UUID;
  /**
   * Opp avanzada que justifica la absorción. Para `draft_orders_*`
   * triggers es la Cotización recién creada; para `corrective_backfill`
   * es cualquier opp activa no-inicial pre-existente del contacto.
   */
  absorbingOpportunityId: UUID;
  /**
   * Etiqueta semántica del disparador — viaja al audit y al note.
   *
   * Triggers en vivo:
   *   - `draft_orders_create`            — Cotización aterriza después
   *                                        del Lead nuevo R12 (race).
   *   - `draft_orders_update_as_create`  — idempotencia inversa del
   *                                        worker draft_orders/update.
   * Trigger one-shot:
   *   - `corrective_backfill`            — script de corrección de
   *                                        históricos. `cancellation_source`
   *                                        es idéntico a los triggers en
   *                                        vivo (mismo invariante de
   *                                        queries y métricas); solo el
   *                                        audit trail los distingue.
   */
  trigger:
    | "draft_orders_create"
    | "draft_orders_update_as_create"
    | "corrective_backfill";
}

export interface AbsorbResult {
  absorbedOpportunityIds: UUID[];
}

export async function absorbInitialStageOpportunities(
  input: AbsorbInput,
): Promise<AbsorbResult> {
  const { supabase, organizationId } = getTenantScopedClient();

  // Mapa posición por etapa del Funnel Venta (posiciones editables).
  const { data: stageRows, error: stagesErr } = await supabase
    .from("pipeline_stages")
    .select("id, position")
    .eq("organization_id", organizationId)
    .eq("funnel", "venta");
  if (stagesErr) throw stagesErr;
  const positionByStage = new Map<UUID, number>(
    (stageRows ?? []).map((r) => [(r as { id: UUID }).id, (r as { position: number }).position]),
  );

  // Posición de la opp absorbente (la Cotización recién creada) = umbral.
  const absorbing = await getOpportunityById(input.absorbingOpportunityId);
  const threshold = absorbing ? positionByStage.get(absorbing.stage_id) : undefined;
  if (threshold === undefined) {
    // Sin umbral resoluble no podemos decidir "anterior a Cotización".
    return { absorbedOpportunityIds: [] };
  }

  // Opps activas (no canceladas) del contacto en Funnel Venta. Default
  // de `listOpportunities` ya filtra `cancelled_at IS NULL`.
  const active = await listOpportunities({
    funnel: "venta",
    contactId: input.contactId,
  });
  const candidates = active.filter((opp) => {
    if (opp.id === input.absorbingOpportunityId) return false;
    // Coexiste si tiene su propia draft ligada (otra negociación).
    if (opp.shopify_draft_order_id) return false;
    const pos = positionByStage.get(opp.stage_id);
    return pos !== undefined && pos < threshold;
  });
  if (candidates.length === 0) {
    return { absorbedOpportunityIds: [] };
  }

  const absorbed: UUID[] = [];
  for (const opp of candidates) {
    const result = await cancelOpportunity({
      opportunityId: opp.id,
      source: ABSORPTION_SOURCE,
      note: `[Sistema] Lead pre-Cotización absorbido por oportunidad avanzada (${input.trigger}). No es pérdida comercial.`,
    });
    if (result.alreadyCancelled) continue;
    absorbed.push(opp.id);
    await recordAuditEvent({
      actorUserId: null,
      eventType: "lead_nuevo_absorbed_by_advanced_opportunity",
      entityType: "opportunity",
      entityId: opp.id,
      payload: {
        absorbed_opportunity_id: opp.id,
        absorbing_opportunity_id: input.absorbingOpportunityId,
        contact_id: input.contactId,
        trigger: input.trigger,
        absorbed_from_stage_id: opp.stage_id,
      } as Json,
    });
  }

  return { absorbedOpportunityIds: absorbed };
}

export { ABSORPTION_SOURCE };
