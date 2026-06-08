import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { recordAuditEvent, createNotification } from "@/lib/db/operational";
import type { Json, UUID } from "@/lib/types/database";

/**
 * Trigger atómico Funnel Venta → Funnel Post-venta (R1 / M7.2 B2).
 *
 * Disparador: COMPLETACIÓN del Draft Order en Shopify (no `orders/paid`
 * — reconciliación V1). La transición todo-o-nada vive en el RPC
 * `trigger_f1_to_f2` (migración 0020, datos comerciales agregados en
 * 0021): marca la F1 como Ganada, crea la hija en la etapa inicial del
 * Funnel Post-venta ("Cotización completada"), hereda contacto + asesor
 * (R2), setea parent, popula `shopify_order_id` y hereda los datos
 * comerciales de la F1 (monto real/estimado, referencia visible y line
 * items). NO hereda `shopify_draft_order_id` (unique constraint +
 * lookup — ver cabecera de 0021). Atomicidad real garantizada por
 * Postgres.
 *
 * Esta capa orquesta: invoca el RPC, registra audit log según el
 * resultado y, si el RPC ABORTA (rollback completo), alerta a los
 * admins. NO contiene lógica transaccional propia — toda la
 * consistencia es responsabilidad del RPC.
 */

export interface TriggerF1ToF2Input {
  /** Oportunidad F1 cuyo Draft Order se completó. */
  opportunityId: UUID;
  /** ID de la Order Shopify creada al completar el draft (gap cerrado). */
  shopifyOrderId: string | null;
  /** ID del evento Shopify para trazabilidad (audit). */
  shopifyEventId: string;
}

export interface TriggerF1ToF2Result {
  status: "fired" | "skipped" | "failed";
  childOpportunityId: UUID | null;
  /** Motivo de skip o failure (para audit_log). */
  reason: string | null;
}

interface RpcResult {
  status: "fired" | "skipped";
  reason: string | null;
  child_opportunity_id: UUID | null;
}

export async function fireF1ToF2Trigger(
  input: TriggerF1ToF2Input,
): Promise<TriggerF1ToF2Result> {
  const { supabase } = getTenantScopedClient();

  const { data, error } = await supabase.rpc("trigger_f1_to_f2", {
    p_opportunity_id: input.opportunityId,
    p_shopify_order_id: input.shopifyOrderId,
  });

  if (error) {
    // El RPC abortó → Postgres revirtió TODO. La F1 quedó en su estado
    // anterior. Audit + alerta a admins (operación crítica de integridad).
    await recordAuditEvent({
      actorUserId: null,
      eventType: "trigger_f1_f2_failed",
      entityType: "opportunity",
      entityId: input.opportunityId,
      payload: {
        shopify_event_id: input.shopifyEventId,
        error: error.message,
      },
    });
    await alertAdmins(
      "Trigger de cierre de venta falló",
      `No se pudo crear el seguimiento de Post-venta para la oportunidad ${input.opportunityId} (${error.message}). La oportunidad quedó intacta; revisar logs.`,
      { opportunity_id: input.opportunityId, error: error.message },
    );
    return { status: "failed", childOpportunityId: null, reason: error.message };
  }

  const result = data as RpcResult;

  if (result.status === "fired") {
    await recordAuditEvent({
      actorUserId: null,
      eventType: "trigger_f1_f2_fired",
      entityType: "opportunity",
      entityId: input.opportunityId,
      payload: {
        shopify_event_id: input.shopifyEventId,
        child_opportunity_id: result.child_opportunity_id,
        shopify_order_id: input.shopifyOrderId,
      },
    });
  } else {
    await recordAuditEvent({
      actorUserId: null,
      eventType: "trigger_f1_f2_skipped",
      entityType: "opportunity",
      entityId: input.opportunityId,
      payload: {
        shopify_event_id: input.shopifyEventId,
        reason: result.reason,
        child_opportunity_id: result.child_opportunity_id,
      },
    });
  }

  return {
    status: result.status,
    childOpportunityId: result.child_opportunity_id,
    reason: result.reason,
  };
}

// ============================================================
// Correctivo — backfill de datos comerciales en hijas pre-fix
// ============================================================

export interface BackfillF1ToF2ChildFieldChange {
  from: string | number | null;
  to: string | number | null;
}

export interface BackfillF1ToF2ChildChanges {
  actual_amount: BackfillF1ToF2ChildFieldChange;
  estimated_amount: BackfillF1ToF2ChildFieldChange;
  shopify_order_id: BackfillF1ToF2ChildFieldChange;
  display_reference: BackfillF1ToF2ChildFieldChange;
  line_items_to_copy: number;
}

export interface BackfillF1ToF2ChildResult {
  status: "fixed" | "would_fix" | "noop" | "skipped";
  reason?: string | null;
  childOpportunityId: UUID | null;
  parentOpportunityId: UUID | null;
  /** Solo en dry-run: detalle de los cambios planeados. */
  changes?: BackfillF1ToF2ChildChanges;
  /** Solo en live (status='fixed'): line items efectivamente copiados. */
  lineItemsCopied?: number;
}

interface BackfillRpcResult {
  status: "fixed" | "would_fix" | "noop" | "skipped";
  reason?: string | null;
  child_opportunity_id: UUID | null;
  parent_opportunity_id?: UUID | null;
  changes?: BackfillF1ToF2ChildChanges;
  line_items_copied?: number;
}

/**
 * Rellena una hija de Post-venta ya existente con los datos
 * comerciales de su F1 madre, reusando el RPC `backfill_f1_to_f2_child`
 * (mismo conjunto de campos y semántica que el trigger arreglado).
 * Idempotente y atómico (garantías en el RPC, migración 0021).
 *
 * `dryRun = true` calcula los cambios sin escribir nada.
 */
export async function backfillF1ToF2Child(
  childId: UUID,
  dryRun: boolean,
): Promise<BackfillF1ToF2ChildResult> {
  const { supabase } = getTenantScopedClient();

  const { data, error } = await supabase.rpc("backfill_f1_to_f2_child", {
    p_child_id: childId,
    p_dry_run: dryRun,
  });
  if (error) throw error;

  const r = data as BackfillRpcResult;
  return {
    status: r.status,
    reason: r.reason ?? null,
    childOpportunityId: r.child_opportunity_id,
    parentOpportunityId: r.parent_opportunity_id ?? null,
    changes: r.changes,
    lineItemsCopied: r.line_items_copied,
  };
}

/**
 * Notifica a todos los admins activos de la org actual. Mismo patrón
 * que el DLQ handler (notificación origin=system).
 */
async function alertAdmins(
  title: string,
  message: string,
  reference: Json,
): Promise<void> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data: admins } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("role", "admin")
    .eq("is_active", true);
  if (!admins || admins.length === 0) return;
  for (const adm of admins) {
    await createNotification({
      user_id: (adm as { user_id: UUID }).user_id,
      notification_type: "trigger_f1_f2_failed",
      origin: "system",
      origin_reference: reference,
      opportunity_id: null,
      contact_id: null,
      title,
      message,
      amount_at_stake: null,
      due_at: null,
      status: "pending",
      snoozed_until: null,
      schema_version: "1",
      completed_at: null,
    });
  }
}
