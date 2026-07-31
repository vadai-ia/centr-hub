import "server-only";
import {
  getInngestClient,
  type WhaapyWebhookEnvelope,
} from "@/lib/inngest/client";
import { runWhaapyWebhookWorker } from "@/lib/inngest/helpers";
import {
  WhaapyConversationCreatedPayloadSchema,
  WhaapyConversationAssignedPayloadSchema,
  WhaapyConversationUnassignedPayloadSchema,
  WhaapyConversationClosedPayloadSchema,
  WhaapyContactGetResponseSchema,
} from "@/lib/whaapy/mappers";
import { whaapyRest } from "@/lib/whaapy/admin-client";
import {
  findContactByWhaapyContactId,
  findContactByPhoneOrEmail,
  updateContact,
} from "@/lib/db/contacts";
import { normalizePhone } from "@/lib/services/identity-matching";
import { ingestWhaapyContact } from "@/lib/services/whaapy-contact-ingest";
import {
  getSupabaseAdminClient,
} from "@/lib/supabase/admin";
import {
  recordAuditEvent,
  createNotification,
} from "@/lib/db/operational";
import { getTenantScopedClient } from "@/lib/db/client";
import { evaluateAndCreateC2Opportunity } from "@/lib/services/r12-auto-creation";
import { updateCustomerTags } from "@/lib/shopify/outbound";
import { getOrganizationById } from "@/lib/db/organizations";
import type { ContactRow, Json, MembershipRow, UUID } from "@/lib/types/database";

/**
 * Workers de eventos de conversación Whaapy (M4 + fix inbound-gap).
 *
 * IMPORTANTE: Whaapy NO emite `contact.created` para un writer ORGÁNICO
 * (primera vez que alguien escribe) — solo `conversation.created`. Por eso
 * este worker es el que CREA el lead en la plataforma (auto-hidratación), no
 * solo un side-effect de actividad. Los payloads usan `conversation_id`
 * (no `id`) y `conversation.assigned` NO trae `contact_id` (solo teléfono) —
 * ver ERRORES.md "conversation.* usa conversation_id, no id".
 *
 * Topics:
 *   - conversation.created    → si el contacto no existe, lo CREA (GET
 *                               snapshot + ingest + mapea agente→asesor) y
 *                               dispara R12 (Lead nuevo). Si existe, actividad
 *                               + R12 (reactividad).
 *   - conversation.assigned   → resuelve contacto por TELÉFONO, mapea
 *                               assigned_to→asesor, setea el asesor + tag
 *                               Shopify (NO propaga a Whaapy — evita eco). No
 *                               resuelto → audit EXPLÍCITO (nunca drop silente).
 *   - conversation.unassigned → resuelve por teléfono, DESASIGNA el asesor.
 *   - conversation.closed     → actividad + audit.
 */

const inngest = getInngestClient();

/** Resuelve un contacto local por whaapy_contact_id (si viene) o por teléfono. */
async function resolveContact(
  whaapyContactId: string | null | undefined,
  phone: string | null | undefined,
): Promise<ContactRow | null> {
  if (whaapyContactId) {
    const byId = await findContactByWhaapyContactId(whaapyContactId);
    if (byId) return byId;
  }
  if (phone) {
    const e164 = normalizePhone(phone, "MX");
    if (e164) return await findContactByPhoneOrEmail({ phone: e164 });
  }
  return null;
}

// ============================================================
// 1) conversation.created — CREA el lead orgánico si no existe
// ============================================================

export const whaapyConversationCreated = inngest.createFunction(
  {
    id: "whaapy-conversation-created",
    retries: 5,
    triggers: [{ event: "whaapy/conversation.created" }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as WhaapyWebhookEnvelope;
    return runWhaapyWebhookWorker(envelope, "conversation.created", async (env) => {
      const parsed = WhaapyConversationCreatedPayloadSchema.parse(env.payload);
      const data = parsed.data;
      const whaapyContactId = data.contact_id ?? null;
      const activityAt = data.created_at ?? data.timestamp ?? env.receivedAt;

      let contact = await resolveContact(whaapyContactId, data.phone_number);

      // ---- Contacto DESCONOCIDO → auto-crear el lead orgánico ----
      if (!contact) {
        if (!whaapyContactId) {
          // Sin contact_id no podemos hacer el GET del snapshot (agente/email).
          // Audit EXPLÍCITO — nunca drop silencioso.
          await recordAuditEvent({
            actorUserId: null,
            eventType: "whaapy_conversation_created_unresolved",
            entityType: "contact",
            entityId: null,
            payload: {
              conversation_id: data.conversation_id,
              phone_number: data.phone_number ?? null,
              reason: "no_contact_id_cannot_hydrate",
            } as Json,
          });
          return { discarded: true, reason: "no_contact_id" };
        }

        // GET del snapshot completo (el payload de conversation.created NO trae
        // el agente ni email/address). Fallo → throw → retry → DLQ.
        let snapshot;
        try {
          const raw = await whaapyRest<unknown>(
            { organizationId: env.organizationId },
            "GET",
            `/contacts/v1/${whaapyContactId}`,
          );
          snapshot = WhaapyContactGetResponseSchema.parse(raw).contact;
        } catch (err) {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "whaapy_reconciliation_failed",
            entityType: "contact",
            entityId: null,
            payload: {
              whaapy_contact_id: whaapyContactId,
              conversation_id: data.conversation_id,
              error: (err as Error).message,
            } as Json,
          });
          throw err;
        }

        const ingested = await ingestWhaapyContact({
          whaapyContactId,
          phone: snapshot.phone_number ?? data.phone_number ?? null,
          name: snapshot.name ?? data.contact_name ?? null,
          email: snapshot.email ?? null,
          address: (snapshot.address ?? null) as Json | null,
          assignedAgentId: snapshot.assigned_agent_id ?? null,
          effectiveUpdatedAt: snapshot.updated_at ?? activityAt,
          receivedAt: env.receivedAt,
        });
        contact = ingested.contact;

        await recordAuditEvent({
          actorUserId: null,
          eventType: "whaapy_contact_created_from_conversation",
          entityType: "contact",
          entityId: contact.id,
          payload: {
            whaapy_contact_id: whaapyContactId,
            conversation_id: data.conversation_id,
            assigned_advisor_id: ingested.advisorFromAgent,
            whaapy_agent_id: snapshot.assigned_agent_id ?? null,
          } as Json,
        });

        // R12: lead orgánico nuevo → "Lead nuevo" (hereda el asesor del agente).
        await evaluateAndCreateC2Opportunity({
          contact,
          trigger: "new_contact_in_whaapy",
          triggeredByEvent: "conversation.created",
          previousActivityAt: null,
          currentActivityAt: env.receivedAt,
        });
        return { contactId: contact.id, created: true };
      }

      // ---- Contacto EXISTENTE → actividad + R12 (reactividad) ----
      const previousActivity = contact.last_whaapy_activity_at;
      await updateContact(contact.id, { last_whaapy_activity_at: activityAt });
      const trigger =
        previousActivity === null ? "new_contact_in_whaapy" : "reactivity_after_n_days";
      await evaluateAndCreateC2Opportunity({
        contact: { ...contact, last_whaapy_activity_at: activityAt },
        trigger,
        triggeredByEvent: "conversation.created",
        previousActivityAt: previousActivity,
        currentActivityAt: activityAt,
      });
      return { contactId: contact.id };
    });
  },
);

// ============================================================
// 2) conversation.assigned — resuelve por TELÉFONO, mapea agente→asesor
// ============================================================

export const whaapyConversationAssigned = inngest.createFunction(
  {
    id: "whaapy-conversation-assigned",
    retries: 5,
    triggers: [{ event: "whaapy/conversation.assigned" }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as WhaapyWebhookEnvelope;
    return runWhaapyWebhookWorker(envelope, "conversation.assigned", async (env) => {
      const parsed = WhaapyConversationAssignedPayloadSchema.parse(env.payload);
      const data = parsed.data;
      const ts = data.assigned_at ?? data.timestamp ?? env.receivedAt;

      const contact = await resolveContact(data.contact_id, data.phone_number);
      if (!contact) {
        // Audit EXPLÍCITO — el drop silencioso es exactamente cómo el bug
        // inbound sobrevivió semanas. Deja rastro accionable (teléfono +
        // agente + conversación) para diagnóstico/backfill.
        await recordAuditEvent({
          actorUserId: null,
          eventType: "whaapy_conversation_assign_unresolved",
          entityType: "contact",
          entityId: null,
          payload: {
            conversation_id: data.conversation_id,
            phone_number: data.phone_number ?? null,
            whaapy_agent_id: data.assigned_to,
            reason: "contact_not_found_by_phone",
          } as Json,
        });
        return { discarded: true, reason: "contact_unresolved" };
      }

      const membership = await findMembershipByWhaapyAgentId(
        contact.organization_id,
        data.assigned_to,
      );
      if (!membership) {
        await recordAuditEvent({
          actorUserId: null,
          eventType: "whaapy_agent_mapping_missing",
          entityType: "contact",
          entityId: contact.id,
          payload: {
            whaapy_agent_id: data.assigned_to,
            whaapy_conversation_id: data.conversation_id,
          } as Json,
        });
        await notifyAdminAboutMissingMapping(contact.organization_id, data.assigned_to);
        await updateContact(contact.id, { last_whaapy_activity_at: ts });
        return { contactId: contact.id, discarded: true, reason: "mapping_missing" };
      }

      // Whaapy asignó el agente → gana como dueño en la plataforma (set).
      if (contact.assigned_advisor_id !== membership.id) {
        const updated = await updateContact(contact.id, {
          assigned_advisor_id: membership.id,
          last_whaapy_activity_at: ts,
        });
        await recordAuditEvent({
          actorUserId: null,
          eventType: "whaapy_agent_advisor_synced",
          entityType: "contact",
          entityId: updated.id,
          payload: {
            whaapy_agent_id: data.assigned_to,
            from_membership_id: contact.assigned_advisor_id,
            to_membership_id: membership.id,
            via: "conversation.assigned",
          } as Json,
        });
        // Tag de vendedor a Shopify (NO propagamos a Whaapy — ya lo tiene, sería eco).
        await propagateVendorTagToShopify(updated, membership);
        return { contactId: updated.id, assignedAdvisorId: membership.id };
      }
      // Ya estaba asignado a ese asesor — solo actividad.
      await updateContact(contact.id, { last_whaapy_activity_at: ts });
      return { contactId: contact.id, assignedAdvisorId: membership.id, unchanged: true };
    });
  },
);

// ============================================================
// 3) conversation.unassigned — DESASIGNA el asesor en la plataforma
// ============================================================

export const whaapyConversationUnassigned = inngest.createFunction(
  {
    id: "whaapy-conversation-unassigned",
    retries: 3,
    triggers: [{ event: "whaapy/conversation.unassigned" }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as WhaapyWebhookEnvelope;
    return runWhaapyWebhookWorker(envelope, "conversation.unassigned", async (env) => {
      const parsed = WhaapyConversationUnassignedPayloadSchema.parse(env.payload);
      const data = parsed.data;
      const ts = data.unassigned_at ?? data.timestamp ?? env.receivedAt;

      const contact = await resolveContact(data.contact_id, data.phone_number);
      if (!contact) {
        await recordAuditEvent({
          actorUserId: null,
          eventType: "whaapy_conversation_unassign_unresolved",
          entityType: "contact",
          entityId: null,
          payload: {
            conversation_id: data.conversation_id,
            phone_number: data.phone_number ?? null,
            reason: "contact_not_found_by_phone",
          } as Json,
        });
        return { discarded: true, reason: "contact_unresolved" };
      }

      if (contact.assigned_advisor_id !== null) {
        const updated = await updateContact(contact.id, {
          assigned_advisor_id: null,
          last_whaapy_activity_at: ts,
        });
        await recordAuditEvent({
          actorUserId: null,
          eventType: "whaapy_agent_advisor_synced",
          entityType: "contact",
          entityId: updated.id,
          payload: {
            whaapy_agent_id: null,
            from_membership_id: contact.assigned_advisor_id,
            to_membership_id: null,
            via: "conversation.unassigned",
          } as Json,
        });
        return { contactId: updated.id, cleared: true };
      }
      await updateContact(contact.id, { last_whaapy_activity_at: ts });
      return { contactId: contact.id, cleared: false };
    });
  },
);

// ============================================================
// 4) conversation.closed → actividad + audit
// ============================================================

export const whaapyConversationClosed = inngest.createFunction(
  {
    id: "whaapy-conversation-closed",
    retries: 3,
    triggers: [{ event: "whaapy/conversation.closed" }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as WhaapyWebhookEnvelope;
    return runWhaapyWebhookWorker(envelope, "conversation.closed", async (env) => {
      const parsed = WhaapyConversationClosedPayloadSchema.parse(env.payload);
      const data = parsed.data;
      const contact = await resolveContact(data.contact_id, data.phone_number);
      if (!contact) return { discarded: true, reason: "contact_unresolved" };
      const ts = data.closed_at ?? data.timestamp ?? env.receivedAt;
      await updateContact(contact.id, { last_whaapy_activity_at: ts });
      await recordAuditEvent({
        actorUserId: null,
        eventType: "whaapy_conversation_closed",
        entityType: "contact",
        entityId: contact.id,
        payload: { whaapy_conversation_id: data.conversation_id } as Json,
      });
      return { contactId: contact.id };
    });
  },
);

// ============================================================
// helpers privados
// ============================================================

async function findMembershipByWhaapyAgentId(
  organizationId: UUID,
  whaapyAgentId: string,
): Promise<MembershipRow | null> {
  const { supabase } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("whaapy_agent_id", whaapyAgentId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return (data as MembershipRow) ?? null;
}

async function notifyAdminAboutMissingMapping(
  organizationId: UUID,
  whaapyAgentId: string,
): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { data: admins } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("role", "admin")
    .eq("is_active", true);
  for (const adm of admins ?? []) {
    await createNotification({
      user_id: (adm as { user_id: UUID }).user_id,
      notification_type: "whaapy_agent_mapping_missing",
      origin: "system",
      origin_reference: { whaapy_agent_id: whaapyAgentId },
      opportunity_id: null,
      contact_id: null,
      title: "Mapeo de agente Whaapy pendiente",
      message: `Asignación Whaapy con agente ${whaapyAgentId} no encontró vendedor local. Mapear desde Admin · Usuarios.`,
      amount_at_stake: null,
      due_at: null,
      status: "pending",
      snoozed_until: null,
      schema_version: "1",
      completed_at: null,
    });
  }
}

async function propagateVendorTagToShopify(
  contact: ContactRow,
  membership: MembershipRow,
): Promise<void> {
  if (!contact.shopify_customer_id) return;
  const { supabase, organizationId } = getTenantScopedClient();
  const { data: mappings } = await supabase
    .from("tag_mappings")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("mapped_membership_id", membership.id);
  const vendorTags = (mappings ?? [])
    .map((m) => (m as { original_tag?: string }).original_tag)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  if (vendorTags.length === 0) {
    await recordAuditEvent({
      actorUserId: null,
      eventType: "vendor_tag_mapping_missing_for_shopify_propagation",
      entityType: "contact",
      entityId: contact.id,
      payload: {
        membership_id: membership.id,
        shopify_customer_id: contact.shopify_customer_id,
      } as Json,
    });
    return;
  }

  try {
    const org = await getOrganizationById(contact.organization_id);
    if (!org?.shopify_store_domain) return;
    await updateCustomerTags({
      ctx: { organizationId: contact.organization_id, shopDomain: org.shopify_store_domain },
      contactId: contact.id,
      shopifyCustomerId: contact.shopify_customer_id,
      currentTags: contact.shopify_tags ?? [],
      tagsToAdd: [vendorTags[0]],
    });
  } catch (err) {
    await recordAuditEvent({
      actorUserId: null,
      eventType: "shopify_vendor_tag_propagation_failed",
      entityType: "contact",
      entityId: contact.id,
      payload: {
        shopify_customer_id: contact.shopify_customer_id,
        membership_id: membership.id,
        error: (err as Error).message,
      } as Json,
    });
  }
}

export const whaapyConversationFunctions = [
  whaapyConversationCreated,
  whaapyConversationAssigned,
  whaapyConversationUnassigned,
  whaapyConversationClosed,
];
