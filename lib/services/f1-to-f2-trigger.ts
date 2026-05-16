import "server-only";
import { requireTenantContext } from "@/lib/tenant/context";
import type { OpportunityRow, UUID } from "@/lib/types/database";

/**
 * Trigger atómico Funnel Venta → Funnel Post-venta (R1).
 *
 * Stub para M1 — implementación en M7. Comportamiento crítico:
 *   - Solo se dispara desde el webhook `orders/paid`. NO desde
 *     movimiento manual a etapa ganada.
 *   - Operación atómica con rollback completo si falla cualquier paso.
 *   - Pre-condiciones validadas ANTES:
 *       1. La oportunidad F1 existe.
 *       2. Tiene `parent_opportunity_id = NULL` (es de venta, no post-venta).
 *       3. La etapa destino tiene `is_won = true`.
 *       4. El Funnel Post-venta de la org tiene etapa con `is_initial = true`.
 *   - Si fallan pre-condiciones: el procesamiento del webhook
 *     continúa normalmente (la orden se marca como pagada), pero
 *     el trigger NO se dispara. Se loguea audit `trigger_f1_f2_skipped`
 *     con razón.
 */

export interface TriggerF1ToF2Input {
  /** Oportunidad F1 que se está cerrando como ganada por orders/paid. */
  opportunityId: UUID;
  /** ID del evento Shopify para idempotencia (R4). */
  shopifyEventId: string;
}

export interface TriggerF1ToF2Result {
  status: "fired" | "skipped" | "failed";
  childOpportunityId?: UUID;
  /** Motivo de skip o failure (para audit_log). */
  reason?: string;
  parentOpportunity?: OpportunityRow;
}

export async function fireF1ToF2Trigger(
  _input: TriggerF1ToF2Input,
): Promise<TriggerF1ToF2Result> {
  requireTenantContext();
  throw new Error("f1-to-f2-trigger: implementación pendiente (M7)");
}
