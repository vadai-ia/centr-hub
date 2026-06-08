import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { recordAuditEvent, createNotification } from "@/lib/db/operational";
import { findPostventaChildOpportunityId } from "@/lib/db/opportunities";
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

// ============================================================
// Re-atribución del asesor de la hija de Post-venta (desde la orden)
// ============================================================

export interface ReattributeChildAdvisorResult {
  status: "fixed" | "would_fix" | "noop" | "skipped";
  reason?: string | null;
  childOpportunityId: UUID | null;
  parentOpportunityId: UUID | null;
  /** shopify_order_id de la orden cuya atribución se usó (si la hubo). */
  orderShopifyOrderId?: string | null;
  fromAdvisorId?: UUID | null;
  toAdvisorId?: UUID | null;
}

interface ReattributeRpcResult {
  status: "fixed" | "would_fix" | "noop" | "skipped";
  reason?: string | null;
  child_opportunity_id: UUID | null;
  parent_opportunity_id?: UUID | null;
  order_shopify_order_id?: string | null;
  from_advisor_id?: UUID | null;
  to_advisor_id?: UUID | null;
}

/**
 * Alinea el asesor de una hija de Post-venta con el de su ORDEN cerrada,
 * reusando el RPC `reattribute_postventa_child_advisor` (migración 0022,
 * misma semántica que el trigger arreglado). Solo cambia el asesor de la
 * hija cuando la orden tiene asesor y difiere; nunca toca la F1 ni el
 * contacto; respeta la guarda anti-reasignación-manual. Idempotente y
 * atómico (garantías en el RPC).
 *
 * `dryRun = true` calcula el cambio sin escribir nada.
 */
export async function reattributePostventaChildAdvisor(
  childId: UUID,
  dryRun: boolean,
  source: string,
): Promise<ReattributeChildAdvisorResult> {
  const { supabase } = getTenantScopedClient();

  const { data, error } = await supabase.rpc(
    "reattribute_postventa_child_advisor",
    { p_child_id: childId, p_dry_run: dryRun, p_source: source },
  );
  if (error) throw error;

  const r = data as ReattributeRpcResult;
  return {
    status: r.status,
    reason: r.reason ?? null,
    childOpportunityId: r.child_opportunity_id,
    parentOpportunityId: r.parent_opportunity_id ?? null,
    orderShopifyOrderId: r.order_shopify_order_id ?? null,
    fromAdvisorId: r.from_advisor_id ?? null,
    toAdvisorId: r.to_advisor_id ?? null,
  };
}

/**
 * Hook desde el worker de orders/*: cuando una orden con asesor se
 * vincula a una F1 que ya tiene hija de Post-venta, re-atribuye el asesor
 * de la hija. Cierra la ventana de carrera en que el draft se completó
 * (trigger F1→F2 disparado, hija nacida con fallback F1) ANTES de que la
 * orden aterrizara con su tag de vendedor.
 *
 * No-op silencioso si la F1 aún no tiene hija (el trigger la creará
 * después leyendo la orden ya presente). El RPC es idempotente, así que
 * invocarlo en cada orders/* del mismo pedido es seguro.
 */
export async function reattributePostventaChildForOrder(args: {
  parentOpportunityId: UUID;
  source: string;
}): Promise<void> {
  const childId = await findPostventaChildOpportunityId(args.parentOpportunityId);
  if (!childId) return;
  await reattributePostventaChildAdvisor(childId, false, args.source);
}

// ============================================================
// Re-atribución del asesor de la opp de Venta (desde el pedido)
// ============================================================

export interface ReattributeVentaOpportunityResult {
  status: "fixed" | "would_fix" | "noop" | "skipped";
  reason?: string | null;
  opportunityId: UUID | null;
  /** shopify_order_id del pedido cuya atribución se usó (si la hubo). */
  orderShopifyOrderId?: string | null;
  /** Siempre null en este flujo — solo rellenamos NULL, nunca pisamos. */
  fromAdvisorId?: UUID | null;
  toAdvisorId?: UUID | null;
}

interface ReattributeVentaRpcResult {
  status: "fixed" | "would_fix" | "noop" | "skipped";
  reason?: string | null;
  opportunity_id: UUID | null;
  order_shopify_order_id?: string | null;
  from_advisor_id?: UUID | null;
  to_advisor_id?: UUID | null;
}

/**
 * Rellena el asesor de una opp de Venta SIN asesor con el de su PEDIDO
 * vinculado, reusando el RPC `reattribute_venta_opportunity_advisor`
 * (migración 0023). Guardrail central: SOLO rellena NULL — si la opp ya
 * tiene asesor (tag de draft, herencia o manual), no se toca. Nunca
 * escribe a la orden ni al contacto. Idempotente y atómico (garantías
 * en el RPC).
 *
 * `dryRun = true` calcula el cambio sin escribir nada.
 */
export async function reattributeVentaOpportunityAdvisor(
  opportunityId: UUID,
  dryRun: boolean,
  source: string,
): Promise<ReattributeVentaOpportunityResult> {
  const { supabase } = getTenantScopedClient();

  const { data, error } = await supabase.rpc(
    "reattribute_venta_opportunity_advisor",
    { p_opportunity_id: opportunityId, p_dry_run: dryRun, p_source: source },
  );
  if (error) throw error;

  const r = data as ReattributeVentaRpcResult;
  return {
    status: r.status,
    reason: r.reason ?? null,
    opportunityId: r.opportunity_id,
    orderShopifyOrderId: r.order_shopify_order_id ?? null,
    fromAdvisorId: r.from_advisor_id ?? null,
    toAdvisorId: r.to_advisor_id ?? null,
  };
}

/**
 * Hook desde el worker de orders/*: cuando un pedido con asesor se
 * vincula a una opp de Venta que está SIN asesor, le rellena el asesor.
 * Cierra la ventana de carrera en que la opp de Venta avanzó por la tag
 * del draft ANTES de que el pedido aterrizara con su tag de vendedor.
 *
 * Convive con `reattributePostventaChildForOrder` sin colisión: esta
 * función toca la opp de Venta (la F1, funnel='venta'); la otra toca la
 * hija de Post-venta (funnel='post_venta'). Filas y funnels distintos.
 *
 * No-op silencioso si la opp ya tiene asesor (rellena solo NULL) o si el
 * pedido aún no tiene asesor. El RPC es idempotente, así que invocarlo
 * en cada orders/* del mismo pedido es seguro.
 */
export async function reattributeVentaOpportunityForOrder(args: {
  opportunityId: UUID;
  source: string;
}): Promise<void> {
  await reattributeVentaOpportunityAdvisor(args.opportunityId, false, args.source);
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
