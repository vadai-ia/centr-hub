import "server-only";
import {
  createOpportunity,
  findPostventaChildOpportunityId,
  getOpportunityById,
  recordStageChange,
  updateOpportunity,
} from "@/lib/db/opportunities";
import { resolvePostventaStages } from "@/lib/services/dashboard-stages";
import { recordAuditEvent } from "@/lib/db/operational";
import { dispatchPostventaPushForReopen } from "@/lib/whaapy-postventa/dispatch";
import type { OpportunityRow, UUID } from "@/lib/types/database";

/**
 * Reapertura de oportunidades hacia "Caso problemático" del Post-venta
 * (M4v2, Bloque D). Un cliente reporta un problema sobre un pedido ya
 * cerrado → el vendedor trae la oportunidad de vuelta a "Caso
 * problemático" para gestionarlo.
 *
 * Modelo HÍBRIDO (decisión del operador) para no romper invariantes al
 * cruzar funnels:
 *
 *   - Opp de POST-VENTA (cerrada/resuelta/activa) → se MUTA en sitio:
 *     pasa a "Caso problemático", se limpian los flags de archivado
 *     (won/lost/resolved/cancelled) para que vuelva a estar viva, y se
 *     marca `reopened_at`. Mismo funnel → sin cruce.
 *
 *   - Opp de VENTA (Ganada/Perdida/…) → NO se muta (eso la sacaría del
 *     win-rate de Venta y rompería su historial). En su lugar:
 *       · si la Venta YA tiene hija Post-venta (la del trigger F1→F2),
 *         se reabre ESA hija (mutación en sitio) — evita duplicar hijas;
 *       · si no tiene hija, se CREA una hija Post-venta nueva enlazada
 *         (`parent_opportunity_id`) en "Caso problemático", heredando
 *         contacto/asesor/datos comerciales como el trigger F1→F2 (NO
 *         hereda `shopify_draft_order_id` — unique constraint, lección
 *         migración 0021). La Venta queda INTACTA.
 *
 * Invariantes respetados: NUNCA toca `assigned_advisor_id` (R2/R5 — la
 * atribución se preserva/hereda, no se reasigna); historial inmutable
 * (solo INSERT en opportunity_stage_history, context='manual'); no toca
 * el motor de transiciones. La opp reabierta vive en "Caso problemático"
 * (sumidero) → el motor no la arrastra.
 */

export type ReopenFailureReason =
  | "not_found"
  | "no_problematic_stage"
  | "internal_error";

export type ReopenResult =
  | { ok: true; opportunityId: UUID; mode: "mutated" | "created_child" }
  | { ok: false; reason: ReopenFailureReason; message: string };

export interface ReopenInput {
  opportunityId: UUID;
  actorUserId: UUID | null;
}

export async function reopenOpportunityIntoProblemCase(
  input: ReopenInput,
): Promise<ReopenResult> {
  const opp = await getOpportunityById(input.opportunityId);
  if (!opp) {
    return {
      ok: false,
      reason: "not_found",
      message: "La oportunidad ya no existe.",
    };
  }

  const { problematicStage } = await resolvePostventaStages();
  if (!problematicStage) {
    return {
      ok: false,
      reason: "no_problematic_stage",
      message: 'El Funnel Post-venta no tiene etapa "Caso problemático".',
    };
  }

  // Hook Post-venta ↔ Whaapy (webhook 2): toda reapertura aterriza en Caso
  // Problemático → push a Whaapy. Non-fatal + gateado por kill switch; la
  // opp reabierta ya persistió antes de encolar.
  const finish = async (
    opportunityId: UUID,
    mode: "mutated" | "created_child",
  ): Promise<ReopenResult> => {
    await dispatchPostventaPushForReopen({
      organizationId: opp.organization_id,
      opportunityId,
    });
    return { ok: true, opportunityId, mode };
  };

  try {
    if (opp.funnel === "post_venta") {
      await mutateIntoProblemCase(
        opp,
        problematicStage.id,
        input.actorUserId,
        "post_venta_direct",
      );
      return await finish(opp.id, "mutated");
    }

    // Venta: reusar la hija Post-venta si ya existe; si no, crear una nueva.
    const childId = await findPostventaChildOpportunityId(opp.id);
    if (childId) {
      const child = await getOpportunityById(childId);
      if (child) {
        await mutateIntoProblemCase(
          child,
          problematicStage.id,
          input.actorUserId,
          "venta_existing_child",
        );
        return await finish(child.id, "mutated");
      }
    }
    const newId = await createProblemCaseChild(
      opp,
      problematicStage.id,
      input.actorUserId,
    );
    return await finish(newId, "created_child");
  } catch {
    return {
      ok: false,
      reason: "internal_error",
      message: "No se pudo reabrir la oportunidad. Intenta nuevamente.",
    };
  }
}

/**
 * Muta una opp de Post-venta a "Caso problemático" y la des-archiva.
 * NO toca `assigned_advisor_id`. Solo inserta historial si la etapa
 * cambió (idempotente si ya estaba en Caso problemático).
 */
async function mutateIntoProblemCase(
  opp: OpportunityRow,
  targetStageId: UUID,
  actorUserId: UUID | null,
  source: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const stageChanged = opp.stage_id !== targetStageId;

  await updateOpportunity(opp.id, {
    stage_id: targetStageId,
    // Des-archivar: vuelve a estar viva.
    won_at: null,
    lost_at: null,
    loss_reason_id: null,
    resolved_at: null,
    resolved_by_user_id: null,
    resolution_note: null,
    cancelled_at: null,
    cancellation_source: null,
    cancellation_note: null,
    reopened_at: nowIso,
    last_modified_at: nowIso,
    last_modified_source: "platform",
  });

  if (stageChanged) {
    await recordStageChange({
      opportunityId: opp.id,
      fromStageId: opp.stage_id,
      toStageId: targetStageId,
      changedByUserId: actorUserId,
      context: "manual",
    });
  }

  await recordAuditEvent({
    actorUserId,
    eventType: "opportunity_reopened",
    entityType: "opportunity",
    entityId: opp.id,
    payload: {
      mode: "mutated",
      source,
      prior_funnel: opp.funnel,
      from_stage_id: opp.stage_id,
      to_stage_id: targetStageId,
      cleared_won_at: opp.won_at,
      cleared_lost_at: opp.lost_at,
      cleared_resolved_at: opp.resolved_at,
      cleared_cancelled_at: opp.cancelled_at,
    },
  });
}

/**
 * Crea una hija Post-venta nueva en "Caso problemático" enlazada a una
 * opp de Venta. Hereda contacto/asesor/datos comerciales (patrón hija
 * F1→F2) salvo `shopify_draft_order_id` (unique constraint). La Venta
 * queda intacta.
 */
async function createProblemCaseChild(
  ventaOpp: OpportunityRow,
  targetStageId: UUID,
  actorUserId: UUID | null,
): Promise<UUID> {
  const nowIso = new Date().toISOString();
  const child = await createOpportunity({
    funnel: "post_venta",
    stage_id: targetStageId,
    contact_id: ventaOpp.contact_id,
    // R2/R5: hereda el asesor de la Venta, no lo reasigna.
    assigned_advisor_id: ventaOpp.assigned_advisor_id,
    // Hereda la marca outbound de la Venta padre (0040 — igual que el
    // asesor y los datos comerciales; la hija mantiene la categoría).
    is_outbound: ventaOpp.is_outbound,
    parent_opportunity_id: ventaOpp.id,
    // NO heredar shopify_draft_order_id (unique constraint — 0021).
    shopify_draft_order_id: null,
    shopify_order_id: ventaOpp.shopify_order_id,
    display_reference: ventaOpp.display_reference,
    actual_amount: ventaOpp.actual_amount,
    estimated_amount: ventaOpp.estimated_amount,
    currency: ventaOpp.currency,
    probability_override: null,
    weighted_amount: null,
    loss_reason_id: null,
    invoice_url: null,
    note: null,
    shipping_address: null,
    last_modified_at: nowIso,
    last_modified_source: "platform",
    won_at: null,
    lost_at: null,
    invoice_sent_at: null,
    cancelled_at: null,
    cancellation_source: null,
    cancellation_note: null,
    shopify_created_at: null,
    reopened_at: nowIso,
  });

  await recordStageChange({
    opportunityId: child.id,
    fromStageId: null,
    toStageId: targetStageId,
    changedByUserId: actorUserId,
    context: "manual",
  });

  await recordAuditEvent({
    actorUserId,
    eventType: "opportunity_reopened",
    entityType: "opportunity",
    entityId: child.id,
    payload: {
      mode: "created_child",
      source: "venta_new_child",
      parent_opportunity_id: ventaOpp.id,
      to_stage_id: targetStageId,
    },
  });

  return child.id;
}
