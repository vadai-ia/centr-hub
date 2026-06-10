import "server-only";
import { getOpportunityById, updateOpportunity } from "@/lib/db/opportunities";
import { recordAuditEvent } from "@/lib/db/operational";
import type { UUID } from "@/lib/types/database";

/**
 * Reasignación MANUAL del asesor de una oportunidad (M9.2). Núcleo único
 * compartido por el flujo individual (detalle de opp, vía contacts.ts) y
 * el bulk (desactivación de vendedor, Block 3).
 *
 * Contrato crítico "marcado como manual" (CLAUDE.md + ERRORES.md):
 * emite el evento de auditoría `opportunity_reassigned` con
 * `actor_user_id` NO nulo. Los hooks automáticos de atribución
 * (reattribute_postventa_child_advisor — guard explícito; orders/*;
 * reconciliación horaria) detectan ese evento y NO pisan la asignación.
 * La F1 de Venta además está protegida por la regla "solo NULL" (0023):
 * cualquier valor no-NULL (incluida una reasignación manual) queda
 * intacto. Por eso una reasignación hecha por el admin manda sobre la
 * automática y la reconciliación NO la revierte.
 *
 * Debe ejecutarse DENTRO de un `withTenantContext`.
 */

export const OPPORTUNITY_REASSIGNED_EVENT = "opportunity_reassigned" as const;

export type ReassignAdvisorOutcome =
  | { ok: true; changed: boolean }
  | { ok: false; reason: "entity_not_found" | "internal_error"; message: string };

export async function reassignOpportunityAdvisor(input: {
  opportunityId: UUID;
  newMembershipId: UUID | null;
  actorUserId: UUID;
}): Promise<ReassignAdvisorOutcome> {
  const opp = await getOpportunityById(input.opportunityId);
  if (!opp) {
    return {
      ok: false,
      reason: "entity_not_found",
      message: "La oportunidad ya no existe.",
    };
  }
  const previous = opp.assigned_advisor_id;
  if (previous === input.newMembershipId) {
    return { ok: true, changed: false };
  }

  const snapshot = { ...opp };
  const nowIso = new Date().toISOString();
  try {
    await updateOpportunity(input.opportunityId, {
      assigned_advisor_id: input.newMembershipId,
      last_modified_at: nowIso,
      last_modified_source: "platform",
    });
  } catch (e) {
    return {
      ok: false,
      reason: "internal_error",
      message:
        e instanceof Error ? e.message : "No se pudo actualizar la oportunidad.",
    };
  }

  // Audit principal — marca la reasignación como manual. Si falla, revertimos.
  try {
    await recordAuditEvent({
      actorUserId: input.actorUserId,
      eventType: OPPORTUNITY_REASSIGNED_EVENT,
      entityType: "opportunity",
      entityId: input.opportunityId,
      payload: {
        from_membership_id: previous,
        to_membership_id: input.newMembershipId,
        contact_id: opp.contact_id,
      },
    });
  } catch {
    try {
      await updateOpportunity(input.opportunityId, {
        assigned_advisor_id: snapshot.assigned_advisor_id,
        last_modified_at: snapshot.last_modified_at,
        last_modified_source: snapshot.last_modified_source,
      });
    } catch {
      // best-effort revert (mismo trade-off que M5)
    }
    return {
      ok: false,
      reason: "internal_error",
      message:
        "No se pudo registrar el cambio en auditoría. La reasignación se revirtió.",
    };
  }

  return { ok: true, changed: true };
}
