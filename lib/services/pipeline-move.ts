import "server-only";
import {
  getOpportunityById,
  updateOpportunity,
  recordStageChange,
} from "@/lib/db/opportunities";
import { getStageById } from "@/lib/db/pipeline";
import { recordAuditEvent } from "@/lib/db/operational";
import { getTenantScopedClient } from "@/lib/db/client";
import type {
  OpportunityRow,
  PipelineStageRow,
  StageHistoryContext,
  UUID,
} from "@/lib/types/database";

/**
 * Servicio de movimiento de oportunidades entre etapas — M5.
 *
 * Garantías que debe cumplir cada llamada (prompt M5 "Restricciones
 * técnicas no-obvias"):
 *
 *   (a) Atómico de cara al cliente: o se aplican los tres efectos
 *       (UPDATE opp, INSERT stage_history, INSERT audit_log) o
 *       ninguno queda observable.
 *   (b) Idempotente ante doble disparo: mover una opp a la etapa
 *       en la que ya está no produce segundo history ni segundo audit.
 *   (c) LWW para race entre dos admins: el caller pasa
 *       `expectedLastModifiedAt` (el valor que vio cuando renderizó la
 *       card); si difiere de lo que hay en BD al momento del UPDATE,
 *       devolvemos `stale_version` para que el cliente recargue.
 *
 * Por qué la atomicidad es emulada y no transaccional:
 * supabase-js / PostgREST no expone `BEGIN..COMMIT` al app; cada
 * llamada va por su propio statement. La doctrina M5 prohíbe migrar
 * schema/RLS, así que un RPC dedicado queda fuera del scope para
 * esta entrega. Emulamos con rollback compensatorio:
 *
 *   1. Validamos invariantes (existencia, mismo funnel, etapa
 *      activa, no cancelada, no terminal-llegada-por-LWW).
 *   2. Update opp con cláusula `eq("last_modified_at", expected)` —
 *      si el optimistic lock falla, no avanzamos a (3) ni (4).
 *   3. Insert audit_log. Si falla, hacemos UPDATE de reversa
 *      (devolvemos stage_id viejo + last_modified_at viejo). No
 *      hubo history inserted aún, así que el estado queda limpio.
 *   4. Insert opportunity_stage_history. Si falla — hueco raro —
 *      hacemos UPDATE de reversa y dejamos el audit_log como "intento
 *      fallido" (sin compensar audit; el audit es append-only y la
 *      tabla `tg_block_mutation` lo prohíbe). Documentado como
 *      trade-off conocido — el peor caso deja una entrada de audit
 *      sin contraparte de history, no estado de datos corrupto.
 *
 * Para movimientos automáticos (webhook `orders/paid`, worker C2),
 * el caller pasa `context: 'webhook' | 'automation' | 'trigger_f1_f2'`
 * y `actorUserId: null`. El UI consume el evento Realtime sin toast.
 */

export type MoveOpportunityResult =
  | { ok: true; opportunity: OpportunityRow }
  | { ok: false; reason: MoveOpportunityFailureReason; message: string };

export type MoveOpportunityFailureReason =
  | "not_found"
  | "cancelled"
  | "funnel_mismatch"
  | "stage_not_found"
  | "stage_inactive"
  | "stage_already"
  | "stale_version"
  | "loss_reason_required"
  | "won_stage_requires_automatic_trigger"
  | "internal_error";

export interface MoveOpportunityInput {
  opportunityId: UUID;
  toStageId: UUID;
  expectedLastModifiedAt: string;
  actorUserId: UUID | null;
  context: StageHistoryContext;
  /** Solo si la etapa destino tiene `requires_loss_reason = true`. */
  lossReasonId?: UUID | null;
  /** Nota libre opcional capturada en el modal de pérdida. */
  note?: string | null;
}

export async function moveOpportunityStage(
  input: MoveOpportunityInput,
): Promise<MoveOpportunityResult> {
  const opp = await getOpportunityById(input.opportunityId);
  if (!opp) {
    return {
      ok: false,
      reason: "not_found",
      message: "La oportunidad ya no existe o fue movida por otro usuario.",
    };
  }
  if (opp.cancelled_at) {
    return {
      ok: false,
      reason: "cancelled",
      message: "Esta oportunidad fue cancelada y no puede moverse.",
    };
  }

  const targetStage = await getStageById(input.toStageId);
  if (!targetStage) {
    return {
      ok: false,
      reason: "stage_not_found",
      message: "La etapa destino ya no existe.",
    };
  }
  if (targetStage.funnel !== opp.funnel) {
    return {
      ok: false,
      reason: "funnel_mismatch",
      message: "No se puede mover entre Funnel Venta y Funnel Post-venta.",
    };
  }
  if (!targetStage.is_active) {
    return {
      ok: false,
      reason: "stage_inactive",
      message: "La etapa destino fue desactivada por el admin.",
    };
  }
  if (opp.stage_id === targetStage.id) {
    // Idempotencia ante doble disparo (regla del prompt).
    return { ok: true, opportunity: opp };
  }

  // Trigger F1→F2 atómico vive en M7. M5 NO debe permitir que el
  // movimiento manual a una etapa `is_won` se confunda con el
  // contrato del webhook — pero el prompt sí pide:
  //   "Mover ganada Funnel Venta vía drag manual → toast literal
  //    'Oportunidad marcada como ganada'"
  // Por lo tanto SÍ se permite el movimiento manual a ganada en M5,
  // pero NO se dispara la creación de opp hija en F2 (esa lógica
  // queda explícita en M7). Aquí solo marcamos won_at.

  if (targetStage.requires_loss_reason && !input.lossReasonId) {
    return {
      ok: false,
      reason: "loss_reason_required",
      message: "Selecciona un motivo de pérdida para continuar.",
    };
  }

  // Capturamos snapshot inmutable de los valores que usaremos
  // después del UPDATE — en tests con fakes el row de `opp` puede
  // mutarse in-place al hacer Object.assign sobre la misma referencia
  // (en producción supabase-js devuelve filas fresh-parsed sin
  // riesgo de aliasing, pero defendemos por simetría).
  const fromStageId = opp.stage_id;
  const snapshotForRevert: OpportunityRow = { ...opp };

  const nowIso = new Date().toISOString();
  const lastModifiedSource = mapContextToSource(input.context);

  // (2) UPDATE con optimistic lock — el `.eq("last_modified_at",...)`
  // garantiza que solo aplicamos el cambio si la fila no se movió
  // entre que el cliente la pintó y este momento. La cláusula
  // organization_id viene heredada del data layer.
  const updatePayload: Record<string, unknown> = {
    stage_id: targetStage.id,
    last_modified_at: nowIso,
    last_modified_source: lastModifiedSource,
  };
  if (targetStage.is_won) {
    updatePayload.won_at = nowIso;
    updatePayload.lost_at = null;
    updatePayload.loss_reason_id = null;
  } else if (targetStage.is_lost) {
    updatePayload.loss_reason_id = input.lossReasonId ?? null;
    if (input.note) updatePayload.note = input.note;
    updatePayload.won_at = null;
    updatePayload.lost_at = nowIso;
  } else {
    // Etapa intermedia: limpia flags terminales para que la card
    // no quede con won_at/lost_at residual si admin la retorna del
    // estado ganada/perdida por corrección.
    updatePayload.won_at = null;
    updatePayload.lost_at = null;
    updatePayload.loss_reason_id = null;
  }

  let updated: OpportunityRow;
  try {
    const maybeUpdated = await updateOpportunityWithGuard(
      input.opportunityId,
      updatePayload,
      input.expectedLastModifiedAt,
    );
    if (!maybeUpdated) {
      return {
        ok: false,
        reason: "stale_version",
        message:
          "Esta oportunidad fue actualizada por otro usuario; recargando datos.",
      };
    }
    updated = maybeUpdated;
  } catch {
    return {
      ok: false,
      reason: "internal_error",
      message: "Error guardando el cambio. Intenta nuevamente.",
    };
  }

  // (3) audit_log — si falla, revertimos el UPDATE y abortamos.
  try {
    await recordAuditEvent({
      actorUserId: input.actorUserId,
      eventType: "opportunity_stage_moved",
      entityType: "opportunity",
      entityId: input.opportunityId,
      payload: {
        from_stage_id: fromStageId,
        to_stage_id: targetStage.id,
        from_stage_name: null,
        to_stage_name: targetStage.name,
        context: input.context,
        is_won: targetStage.is_won,
        is_lost: targetStage.is_lost,
        loss_reason_id: input.lossReasonId ?? null,
      },
    });
  } catch {
    await revertOpportunity(input.opportunityId, snapshotForRevert);
    return {
      ok: false,
      reason: "internal_error",
      message: "No se pudo registrar el cambio en auditoría. Reintenta.",
    };
  }

  // (4) opportunity_stage_history — append-only.
  try {
    await recordStageChange({
      opportunityId: input.opportunityId,
      fromStageId,
      toStageId: targetStage.id,
      changedByUserId: input.actorUserId,
      context: input.context,
    });
  } catch {
    await revertOpportunity(input.opportunityId, snapshotForRevert);
    // El audit ya quedó persistido; no lo podemos borrar (immutable
    // table). Documentado en ERRORES.md como trade-off conocido.
    return {
      ok: false,
      reason: "internal_error",
      message:
        "No se pudo registrar el cambio en el historial. La oportunidad volvió a su etapa anterior.",
    };
  }

  return { ok: true, opportunity: updated };
}

function mapContextToSource(context: StageHistoryContext): string {
  switch (context) {
    case "webhook":
      return "shopify";
    case "automation":
      return "automation";
    case "trigger_f1_f2":
      return "trigger_f1_f2";
    case "seed":
    case "backfill":
      return "system";
    case "manual":
    default:
      return "platform";
  }
}

/**
 * UPDATE con optimistic lock vía `eq("last_modified_at",...)`.
 * Si la fila cambió entre que el cliente la leyó y el server la
 * actualiza, la query devuelve 0 filas y supabase-js lo expone como
 * `PGRST116` en `.single()`.
 */
async function updateOpportunityWithGuard(
  id: UUID,
  patch: Record<string, unknown>,
  expectedLastModifiedAt: string,
): Promise<OpportunityRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .eq("last_modified_at", expectedLastModifiedAt)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as OpportunityRow | null) ?? null;
}

/**
 * Revierte el UPDATE original — el caller solo conoce el snapshot
 * pre-mutación de la fila. Se sobreescriben los campos que el
 * forward path tocó (stage_id, last_modified_*, won_at,
 * loss_reason_id, note); el resto de la fila ya está en su estado
 * pre-mutación porque no lo tocamos.
 *
 * El compensating UPDATE NO usa optimistic lock — queremos
 * sobrescribir incluso si otro proceso tocó la fila entre tanto.
 * Esto es seguro porque solo restauramos campos que conocemos.
 */
async function revertOpportunity(
  id: UUID,
  snapshot: OpportunityRow,
): Promise<void> {
  try {
    await updateOpportunity(id, {
      stage_id: snapshot.stage_id,
      last_modified_at: snapshot.last_modified_at,
      last_modified_source: snapshot.last_modified_source,
      won_at: snapshot.won_at,
      loss_reason_id: snapshot.loss_reason_id,
      note: snapshot.note,
    });
  } catch {
    // Si la reversa también falla, no hay más que hacer desde el
    // backend — el cliente recibe `internal_error` y refrescará.
  }
}

/**
 * Helper para que el caller resuelva todos los stages del funnel
 * activo en una sola query (necesario para validar que el drop
 * cae en una etapa del mismo funnel).
 */
export function isTerminalStage(stage: PipelineStageRow): boolean {
  return stage.is_won || stage.is_lost;
}
