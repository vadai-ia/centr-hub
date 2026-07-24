import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { getOpportunityById, updateOpportunity } from "@/lib/db/opportunities";
import { getContactById } from "@/lib/db/contacts";
import { recordAuditEvent } from "@/lib/db/operational";
import { recordWhaapySyncIntent } from "@/lib/inngest/functions/customers";
import type { Json, UUID } from "@/lib/types/database";

/**
 * Handoff Outbound → Venta (Fase 3). Envuelve el RPC atómico
 * `handoff_outbound_opportunity` (migración 0043) — el flip in-place vive en
 * SQL para ser atómico (toca funnel, un invariante estructural). Aquí solo
 * se invoca y se audita.
 */

interface HandoffRpcResult {
  status: "handed_off" | "skipped" | "error";
  reason?: string | null;
  opportunity_id?: UUID;
  contact_id?: UUID;
  target_stage_id?: UUID;
  advisor_membership_id?: UUID;
}

export interface HandoffResult {
  ok: boolean;
  /** Motivo de fallo/skip (para traducir a mensaje en la action). */
  reason?: string | null;
}

export async function handoffOutboundOpportunity(args: {
  opportunityId: UUID;
  advisorMembershipId: UUID;
  actorUserId: UUID | null;
}): Promise<HandoffResult> {
  const { supabase } = getTenantScopedClient();

  const { data, error } = await supabase.rpc("handoff_outbound_opportunity", {
    p_opportunity_id: args.opportunityId,
    p_advisor_membership_id: args.advisorMembershipId,
  });

  if (error) {
    // El RPC abortó → Postgres revirtió TODO; la opp quedó en Outbound.
    await recordAuditEvent({
      actorUserId: args.actorUserId,
      eventType: "outbound_handoff_failed",
      entityType: "opportunity",
      entityId: args.opportunityId,
      payload: { error: error.message } as Json,
    });
    return { ok: false, reason: error.message };
  }

  const result = data as HandoffRpcResult;
  if (result.status === "handed_off") {
    await recordAuditEvent({
      actorUserId: args.actorUserId,
      eventType: "outbound_opportunity_handed_off",
      entityType: "opportunity",
      entityId: args.opportunityId,
      payload: {
        advisor_membership_id: args.advisorMembershipId,
        target_stage_id: result.target_stage_id ?? null,
      } as Json,
    });

    // Track 2: el RPC ya asignó el vendedor al CONTACTO (atómico). Ahora se
    // propaga a Whaapy con el agente mapeado (mismo camino que createLead /
    // reasignación de contacto). El worker resuelve whaapy_agent_id desde el
    // snapshot del contacto. Non-fatal: la entrega ya persistió; un fallo al
    // ENCOLAR no la revierte (se audita; reintenta el worker / se re-dispara).
    if (result.contact_id) {
      try {
        const contact = await getContactById(result.contact_id);
        if (contact && contact.phone && !contact.missing_phone) {
          await recordWhaapySyncIntent(
            contact,
            contact.whaapy_contact_id
              ? "update_from_platform_ui"
              : "create_from_platform_ui",
          );
        }
      } catch (err) {
        await recordAuditEvent({
          actorUserId: args.actorUserId,
          eventType: "outbound_handoff_whaapy_enqueue_failed",
          entityType: "opportunity",
          entityId: args.opportunityId,
          payload: { error: (err as Error)?.message ?? String(err) } as Json,
        });
      }
    }
    return { ok: true };
  }

  // skipped (no_outbound/cancelled) o error (advisor/target). Se audita el
  // no-op para trazabilidad y se devuelve el motivo.
  await recordAuditEvent({
    actorUserId: args.actorUserId,
    eventType: "outbound_handoff_skipped",
    entityType: "opportunity",
    entityId: args.opportunityId,
    payload: { status: result.status, reason: result.reason ?? null } as Json,
  });
  return { ok: false, reason: result.reason ?? result.status };
}

/**
 * Advertencia de conflicto de asesor por tag de ORDEN (Fase 3). El hook 0023
 * (`reattribute_venta_opportunity_advisor`) ya CONSERVA el asesor de la entrega
 * (solo rellena NULL). Esto NO cambia el asesor — solo marca el conflicto para
 * advertir cuando el tag de la orden nombra a alguien DISTINTO del asesor de la
 * entrega en una opp outbound. Debe llamarse DESPUÉS del reattribute. Non-fatal.
 */
export async function flagOrderTagConflictIfHandoffKept(args: {
  ventaOpportunityId: UUID;
  orderTagAdvisorId: UUID | null;
}): Promise<void> {
  if (!args.orderTagAdvisorId) return;
  const opp = await getOpportunityById(args.ventaOpportunityId);
  if (!opp || !opp.is_outbound) return;
  // El asesor actual (handoff) se conservó; si el tag de la orden nombra a otro
  // y no está ya marcado, marcar el conflicto (sin tocar assigned_advisor_id).
  if (
    opp.assigned_advisor_id &&
    opp.assigned_advisor_id !== args.orderTagAdvisorId &&
    opp.overridden_tag_advisor_id !== args.orderTagAdvisorId
  ) {
    await updateOpportunity(opp.id, { overridden_tag_advisor_id: args.orderTagAdvisorId });
    await recordAuditEvent({
      actorUserId: null,
      eventType: "handoff_advisor_kept_over_shopify_tag",
      entityType: "opportunity",
      entityId: opp.id,
      payload: {
        handoff_advisor_id: opp.assigned_advisor_id,
        shopify_tag_advisor_id: args.orderTagAdvisorId,
        source: "order",
      } as Json,
    });
  }
}
