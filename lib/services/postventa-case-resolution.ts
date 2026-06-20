import "server-only";
import {
  getOpportunityById,
  updateOpportunity,
} from "@/lib/db/opportunities";
import { recordAuditEvent } from "@/lib/db/operational";
import { resolvePostventaEngineStages } from "@/lib/services/postventa-transition";
import type { OpportunityRow, UUID } from "@/lib/types/database";

/**
 * Cierre de "Caso problemático" de Post-venta (M3v2, Bloque E).
 *
 * El motor manda a "Caso problemático" las opps cuyo pedido se canceló o
 * reembolsó. Ahí una persona revisa y, cuando lo resuelve, marca el caso
 * como cerrado: se setean `resolved_at` + `resolved_by_user_id` +
 * `resolution_note`. El caso queda ARCHIVADO (fuera de las vistas activas)
 * pero la etapa NO cambia (se preserva el contexto de auditoría — mismo
 * patrón que "cancelado ≠ perdido", 0014).
 *
 * Idempotente: re-resolver un caso ya resuelto es no-op (`already_resolved`).
 * Atribución intacta: NO toca `assigned_advisor_id`.
 */

export type ResolveCaseResult =
  | { ok: true; opportunity: OpportunityRow }
  | { ok: false; reason: ResolveCaseFailureReason; message: string };

export type ResolveCaseFailureReason =
  | "not_found"
  | "not_post_venta"
  | "not_in_problematic"
  | "already_resolved"
  | "internal_error";

export interface ResolvePostventaCaseInput {
  opportunityId: UUID;
  /** Usuario (auth/profile id) que cierra el caso. */
  resolvedByUserId: UUID;
  /** Nota libre opcional de cómo se resolvió. */
  note?: string | null;
}

export async function resolvePostventaCase(
  input: ResolvePostventaCaseInput,
): Promise<ResolveCaseResult> {
  const opp = await getOpportunityById(input.opportunityId);
  if (!opp) {
    return { ok: false, reason: "not_found", message: "La oportunidad ya no existe." };
  }
  if (opp.funnel !== "post_venta") {
    return {
      ok: false,
      reason: "not_post_venta",
      message: "Solo los casos de Post-venta pueden resolverse.",
    };
  }
  if (opp.resolved_at) {
    // Idempotencia: ya cerrado.
    return {
      ok: false,
      reason: "already_resolved",
      message: "Este caso ya fue resuelto.",
    };
  }

  const stages = await resolvePostventaEngineStages();
  if (!stages) {
    return {
      ok: false,
      reason: "internal_error",
      message: "No se pudo resolver el funnel Post-venta.",
    };
  }
  if (opp.stage_id !== stages.problematicStage.id) {
    return {
      ok: false,
      reason: "not_in_problematic",
      message: "Solo se puede resolver un caso que está en “Caso problemático”.",
    };
  }

  const nowIso = new Date().toISOString();
  const note = input.note?.trim() ? input.note.trim() : null;

  let updated: OpportunityRow;
  try {
    updated = await updateOpportunity(input.opportunityId, {
      resolved_at: nowIso,
      resolved_by_user_id: input.resolvedByUserId,
      resolution_note: note,
      // La etapa NO se toca: el caso se queda en "Caso problemático".
    });
  } catch {
    return {
      ok: false,
      reason: "internal_error",
      message: "No se pudo guardar el cierre del caso. Reintenta.",
    };
  }

  await recordAuditEvent({
    actorUserId: input.resolvedByUserId,
    eventType: "postventa_case_resolved",
    entityType: "opportunity",
    entityId: input.opportunityId,
    payload: {
      stage_id: opp.stage_id,
      resolved_at: nowIso,
      has_note: note !== null,
    },
  });

  return { ok: true, opportunity: updated };
}
