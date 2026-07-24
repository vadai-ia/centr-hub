import "server-only";
import { getOpportunityById, updateOpportunity } from "@/lib/db/opportunities";
import {
  recordAuditEvent,
  listOpenTasksForOpportunity,
  listOpenNotificationsForOpportunity,
  updateTask,
  updateNotification,
  listOrgAdminUserIds,
  getMembershipUserId,
} from "@/lib/db/operational";
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
 * Cascada de pertenencia (correctivo M1v2): el contenido accionable —
 * tareas y avisos ABIERTOS — pertenece a la OPP, no a la persona. Al
 * cambiar el asesor, ese contenido SIGUE a la opp: pasa al Mi Día del
 * nuevo asesor y deja de aparecerle al anterior (Mi Día filtra por
 * `assigned_user_id`/`user_id`, no por el asesor de la opp). Si la opp
 * queda sin asesor (NULL), el admin de respaldo los custodia. Las notas
 * (activities) ya seguían a la opp por estar ligadas solo a `opportunity_id`.
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
      // Reasignar manualmente resuelve cualquier conflicto de tag de Shopify
      // (handoff vs tag, 0043): el humano decidió → se limpia la advertencia.
      overridden_tag_advisor_id: null,
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
        overridden_tag_advisor_id: snapshot.overridden_tag_advisor_id,
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

  // Cascada de pertenencia — best-effort. El cambio de asesor (intención
  // primaria) ya persistió y se auditó; una falla aquí NO lo revierte (la
  // cascada es derivada del asesor actual y se puede re-disparar). Se
  // registra para diagnóstico.
  try {
    const targetUserId = await resolveCascadeTargetUserId(input.newMembershipId);
    if (targetUserId) {
      await cascadeOwnershipToUser(input.opportunityId, targetUserId);
    }
  } catch (e) {
    await recordAuditEvent({
      actorUserId: input.actorUserId,
      eventType: "opportunity_reassign_cascade_failed",
      entityType: "opportunity",
      entityId: input.opportunityId,
      payload: { error: e instanceof Error ? e.message : String(e) },
    }).catch(() => {});
  }

  return { ok: true, changed: true };
}

/**
 * Destinatario de la cascada: el `user_id` del nuevo asesor; si la opp
 * queda sin asesor (NULL) o el membership no resuelve usuario, el admin de
 * respaldo (el de menor `user_id`, determinista) los custodia — mismo
 * criterio que el fallback de `create_task` en el motor de reglas.
 */
async function resolveCascadeTargetUserId(
  newMembershipId: UUID | null,
): Promise<UUID | null> {
  if (newMembershipId) {
    const uid = await getMembershipUserId(newMembershipId);
    if (uid) return uid;
  }
  const admins = await listOrgAdminUserIds();
  return [...admins].sort()[0] ?? null;
}

/**
 * Mueve las tareas y avisos ABIERTOS de la opp al usuario destino. Lee y
 * actualiza por id (en vez de un UPDATE masivo) para preservar la
 * granularidad por status y ser compatible con el cliente de pruebas. Solo
 * escribe cuando el dueño cambia (evita churn de `updated_at`).
 */
async function cascadeOwnershipToUser(
  opportunityId: UUID,
  targetUserId: UUID,
): Promise<void> {
  const [tasks, notifs] = await Promise.all([
    listOpenTasksForOpportunity(opportunityId),
    listOpenNotificationsForOpportunity(opportunityId),
  ]);
  for (const t of tasks) {
    if (t.assigned_user_id !== targetUserId) {
      await updateTask(t.id, { assigned_user_id: targetUserId });
    }
  }
  for (const n of notifs) {
    if (n.user_id !== targetUserId) {
      await updateNotification(n.id, { user_id: targetUserId });
    }
  }
}
