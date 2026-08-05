import "server-only";
import { getOpportunityById, updateOpportunity } from "@/lib/db/opportunities";
import { listActiveCustomerSuccess } from "@/lib/db/users";
import { recordAuditEvent } from "@/lib/db/operational";
import type { UUID } from "@/lib/types/database";

/**
 * Asignación del Customer Success de una oportunidad de Post-venta (0047).
 *
 * Es un eje INDEPENDIENTE del asesor: este servicio NUNCA toca
 * `assigned_advisor_id`. El vendedor que cerró la venta conserva la
 * oportunidad; el Customer Success se SUMA en su propia ranura. Por eso NO
 * reusa `reassignOpportunityAdvisor` ni emite `opportunity_reassigned` —
 * ese evento es el contrato "reasignación manual del asesor" que los hooks
 * automáticos de atribución leen para no pisar (CLAUDE.md + 0022/0023);
 * emitirlo aquí ensuciaría esa señal con un cambio que no es de asesor.
 *
 * "Un solo Customer Success" es estructural, no una regla que haya que
 * hacer cumplir: la ranura es UNA columna, así que asignar otro reemplaza
 * al anterior por construcción.
 *
 * Tampoco cascadea tareas ni avisos (a diferencia de la reasignación de
 * asesor): el contenido accionable sigue perteneciendo al asesor de la opp.
 *
 * Debe ejecutarse DENTRO de un `withTenantContext`.
 */

export const OPPORTUNITY_CUSTOMER_SUCCESS_EVENT =
  "opportunity_customer_success_assigned" as const;

export type AssignCustomerSuccessOutcome =
  | { ok: true; changed: boolean }
  | {
      ok: false;
      reason:
        | "entity_not_found"
        | "not_postventa"
        | "membership_not_eligible"
        | "internal_error";
      message: string;
    };

export async function assignOpportunityCustomerSuccess(input: {
  opportunityId: UUID;
  organizationId: UUID;
  /** Membership del CS, o null para dejar la oportunidad sin Customer Success. */
  newMembershipId: UUID | null;
  actorUserId: UUID;
}): Promise<AssignCustomerSuccessOutcome> {
  const opp = await getOpportunityById(input.opportunityId);
  if (!opp) {
    return {
      ok: false,
      reason: "entity_not_found",
      message: "La oportunidad ya no existe.",
    };
  }

  // La ranura es semántica exclusiva de Post-venta. Permitirla en Venta u
  // Outbound dejaría datos que ninguna vista lee y que el filtro no espera.
  if (opp.funnel !== "post_venta") {
    return {
      ok: false,
      reason: "not_postventa",
      message:
        "El Customer Success solo se asigna en oportunidades de Post-venta.",
    };
  }

  // El destino tiene que ser un CS activo y real de ESTA organización. Se
  // valida contra el mismo listado que alimenta el selector, así la UI y el
  // backend nunca discrepan sobre quién es elegible.
  if (input.newMembershipId !== null) {
    const eligible = await listActiveCustomerSuccess(input.organizationId);
    if (!eligible.some((m) => m.id === input.newMembershipId)) {
      return {
        ok: false,
        reason: "membership_not_eligible",
        message:
          "El usuario seleccionado no es un Customer Success activo de la organización.",
      };
    }
  }

  const previous = opp.customer_success_membership_id;
  if (previous === input.newMembershipId) {
    return { ok: true, changed: false };
  }

  try {
    await updateOpportunity(input.opportunityId, {
      customer_success_membership_id: input.newMembershipId,
    });
  } catch (e) {
    return {
      ok: false,
      reason: "internal_error",
      message:
        e instanceof Error
          ? e.message
          : "No se pudo actualizar el Customer Success de la oportunidad.",
    };
  }

  // Audit — si falla, se revierte: el cambio de persona responsable tiene
  // que quedar trazado o no haber ocurrido (mismo criterio que la
  // reasignación de asesor).
  try {
    await recordAuditEvent({
      actorUserId: input.actorUserId,
      eventType: OPPORTUNITY_CUSTOMER_SUCCESS_EVENT,
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
        customer_success_membership_id: previous,
      });
    } catch {
      // best-effort revert (mismo trade-off que la reasignación de asesor)
    }
    return {
      ok: false,
      reason: "internal_error",
      message:
        "No se pudo registrar el cambio en auditoría. La asignación se revirtió.",
    };
  }

  return { ok: true, changed: true };
}
