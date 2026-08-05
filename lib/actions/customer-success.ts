"use server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { canAssignCustomerSuccess } from "@/lib/auth/capabilities";
import { withTenantContext } from "@/lib/tenant/context";
import { assignOpportunityCustomerSuccess } from "@/lib/services/opportunity-customer-success";
import type { UUID } from "@/lib/types/database";

/**
 * Asignación del Customer Success de una oportunidad de Post-venta (0047).
 *
 * Permisos (decisión del operador): los roles con alcance de datos completo
 * (admin/superadmin/SDR) y el propio Customer Success. Un vendedor NO
 * designa al CS — puede ver quién es, no cambiarlo.
 *
 * El servicio revalida elegibilidad del destino y que la opp sea de
 * Post-venta: el gate de UI no es una garantía.
 */

const assignSchema = z.object({
  opportunityId: z.string().uuid(),
  /** null = quitar el Customer Success de la oportunidad. */
  membershipId: z.string().uuid().nullable(),
});

export type AssignCustomerSuccessResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: string; message: string };

export async function assignCustomerSuccessAction(
  raw: unknown,
): Promise<AssignCustomerSuccessResult> {
  const parsed = assignSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_input",
      message: "Parámetros de asignación inválidos.",
    };
  }

  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, reason: "no_session", message: "Sesión expirada." };
  }
  const orgId = session.data.activeOrg.id;
  const userId = session.data.userId;
  const role = session.data.activeRole;

  if (!canAssignCustomerSuccess(role)) {
    return {
      ok: false,
      reason: "forbidden",
      message:
        "Solo un administrador o un Customer Success puede cambiar esta asignación.",
    };
  }

  return withTenantContext(
    orgId,
    async () => {
      const outcome = await assignOpportunityCustomerSuccess({
        opportunityId: parsed.data.opportunityId as UUID,
        organizationId: orgId,
        newMembershipId: (parsed.data.membershipId as UUID | null) ?? null,
        actorUserId: userId,
      });
      if (!outcome.ok) {
        return {
          ok: false,
          reason: outcome.reason,
          message: outcome.message,
        } as const;
      }
      return { ok: true, changed: outcome.changed } as const;
    },
    { source: "user_session" },
  );
}
