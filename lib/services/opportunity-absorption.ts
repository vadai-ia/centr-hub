import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import {
  cancelOpportunity,
  listOpportunities,
} from "@/lib/db/opportunities";
import { recordAuditEvent } from "@/lib/db/operational";
import type { Json, UUID } from "@/lib/types/database";

/**
 * Absorción del "Lead nuevo" cuando llega una oportunidad más avanzada.
 *
 * Regla de negocio (CLAUDE.md "Auto-creación C2 — Modelo C2 (R12)"):
 * la coexistencia de "Lead nuevo" (etapa `is_initial = true`) con otra
 * oportunidad activa del mismo contacto en Funnel Venta NUNCA es un
 * estado válido. R12 cubre la dirección "no crees el Lead nuevo si ya
 * hay opp avanzada"; este servicio cubre la dirección inversa: cuando
 * la opp avanzada (típicamente Cotización desde `draft_orders/create`)
 * aterriza después del Lead nuevo por race de webhooks, el Lead nuevo
 * se absorbe.
 *
 * Mecánica:
 *   - Lista opps activas (no canceladas) del contacto en Funnel Venta
 *     en etapa `is_initial = true`, excluyendo la propia opp absorbente
 *     (defensivo: nunca cancelar la opp que acaba de crearse).
 *   - Cancela cada match con `cancelOpportunity(source =
 *     "absorbed_by_advanced_opportunity")`. Cancelación ≠ pérdida —
 *     el Lead absorbido NO contamina win rate (R5) ni se transita a
 *     etapa "Perdida" (preserva auditoría: la etapa al momento de
 *     absorción queda en el row).
 *   - Audit log `lead_nuevo_absorbed_by_advanced_opportunity` con la
 *     opp absorbente y la absorbida.
 *
 * Idempotente: si no hay Lead nuevo activo, es no-op. Si la absorbente
 * misma está en etapa inicial (no debería pasar por el caller), se
 * excluye del set.
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

  // Resolver etapas iniciales (`is_initial = true`) del Funnel Venta
  // por id. Soporta el caso defensivo de que el admin haya creado
  // varias etapas iniciales (improbable — el bootstrap garantiza una
  // sola, pero `pipeline_stages` no tiene constraint estricto).
  const { data: initialStages, error: stagesErr } = await supabase
    .from("pipeline_stages")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("funnel", "venta")
    .eq("is_initial", true);
  if (stagesErr) throw stagesErr;
  const initialStageIds = (initialStages ?? []).map(
    (r) => (r as { id: UUID }).id,
  );
  if (initialStageIds.length === 0) {
    return { absorbedOpportunityIds: [] };
  }

  // Opps activas (no canceladas) del contacto en Funnel Venta. Default
  // de `listOpportunities` ya filtra `cancelled_at IS NULL`.
  const active = await listOpportunities({
    funnel: "venta",
    contactId: input.contactId,
  });
  const candidates = active.filter(
    (opp) =>
      opp.id !== input.absorbingOpportunityId &&
      initialStageIds.includes(opp.stage_id),
  );
  if (candidates.length === 0) {
    return { absorbedOpportunityIds: [] };
  }

  const absorbed: UUID[] = [];
  for (const opp of candidates) {
    const result = await cancelOpportunity({
      opportunityId: opp.id,
      source: ABSORPTION_SOURCE,
      note: `[Sistema] Lead nuevo absorbido por oportunidad avanzada (${input.trigger}). No es pérdida comercial.`,
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
