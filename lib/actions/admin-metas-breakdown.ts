"use server";
import { z } from "zod";
import { resolveAdminContext } from "@/lib/auth/admin-guard";
import { withTenantContext } from "@/lib/tenant/context";
import {
  loadGoalAmountBreakdown,
  type AmountBreakdown,
} from "@/lib/services/goal-amount-breakdown";
import type { GoalScope } from "@/lib/services/dashboard-metrics";

/**
 * "Ver pedidos" de la meta de monto en Admin → Metas → Avance por mes. Solo
 * admin (misma pestaña que el resto de Metas): expone clientes y montos de
 * toda la organización.
 */

const monthKey = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const inputSchema = z.discriminatedUnion("subject", [
  z.object({ monthKey, subject: z.literal("team") }),
  z.object({ monthKey, subject: z.literal("organic") }),
  z.object({ monthKey, subject: z.literal("advisor"), advisorMembershipId: z.string().uuid() }),
]);

export type AmountBreakdownResult =
  | { ok: true; breakdown: AmountBreakdown }
  | { ok: false; message: string };

export async function loadAmountBreakdownAction(raw: unknown): Promise<AmountBreakdownResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos inválidos." };
  const admin = await resolveAdminContext("admin-metas");
  if (!admin.ok) return admin;

  const input = parsed.data;
  const scope: GoalScope =
    input.subject === "advisor"
      ? { kind: "advisor", membershipId: input.advisorMembershipId }
      : { kind: input.subject };

  return withTenantContext(
    admin.ctx.orgId,
    async () => {
      const breakdown = await loadGoalAmountBreakdown(input.monthKey, scope);
      if (!breakdown) return { ok: false as const, message: "Mes inválido." };
      return { ok: true as const, breakdown };
    },
    { source: "user_session" },
  );
}
