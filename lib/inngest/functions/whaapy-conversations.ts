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
} from "@/lib/whaapy/mappers";
import {
  findContactByWhaapyContactId,
  updateContact,
} from "@/lib/db/contacts";
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
 * Workers de eventos de conversación Whaapy (M4).
 *
 * Topics:
 *   - conversation.created   → actualiza last_whaapy_activity_at +
 *                              evalúa R12 (a) y (b).
 *   - conversation.assigned  → mapea assigned_to → memberships.whaapy_agent_id
 *                              → propaga al maestro + propaga tag de vendedor
 *                                a Shopify si el contact tiene shopify_customer_id.
 *   - conversation.unassigned → audit + actualiza last_whaapy_activity_at.
 *   - conversation.closed    → audit + actualiza last_whaapy_activity_at.
 */

const inngest = getInngestClient();

// ============================================================
// 1) conversation.created
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
      const contact = await findContactByWhaapyContactId(data.contact_id);
      if (!contact) {
        // Conversación de un contacto no conocido — registramos pero no
        // creamos contact desde acá (el contact.created vendrá luego).
        await recordAuditEvent({
          actorUserId: null,
          eventType: "whaapy_conversation_for_unknown_contact",
          entityType: "contact",
          entityId: null,
          payload: { whaapy_contact_id: data.contact_id, conversation_id: data.id },
        });
        return { discarded: true, reason: "contact_unknown" };
      }

      const previousActivity = contact.last_whaapy_activity_at;
      const newActivity = data.created_at ?? env.receivedAt;
      await updateContact(contact.id, {
        last_whaapy_activity_at: newActivity,
      });

      // Re-leer contact con su nuevo last_whaapy_activity_at para
      // pasarlo limpio al evaluador R12 (idempotente: el evaluador
      // no usa last_whaapy_activity_at del contact, sino los
      // parámetros previousActivityAt / currentActivityAt).
      const trigger = previousActivity === null
        ? "new_contact_in_whaapy"
        : "reactivity_after_n_days";

      await evaluateAndCreateC2Opportunity({
        contact: { ...contact, last_whaapy_activity_at: newActivity },
        trigger,
        triggeredByEvent: "conversation.created",
        previousActivityAt: previousActivity,
        currentActivityAt: newActivity,
      });

      return { contactId: contact.id, trigger };
    });
  },
);

// ============================================================
// 2) conversation.assigned — mapea agente Whaapy → vendedor local
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
      const contact = await findContactByWhaapyContactId(data.contact_id);
      if (!contact) {
        await recordAuditEvent({
          actorUserId: null,
          eventType: "whaapy_conversation_for_unknown_contact",
          entityType: "contact",
          entityId: null,
          payload: { whaapy_contact_id: data.contact_id, conversation_id: data.id },
        });
        return { discarded: true, reason: "contact_unknown" };
      }

      const ts = data.assigned_at ?? env.receivedAt;
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
            whaapy_conversation_id: data.id,
          } as Json,
        });
        await notifyAdminAboutMissingMapping(
          contact.organization_id,
          data.assigned_to,
        );
        await updateContact(contact.id, {
          last_whaapy_activity_at: ts,
        });
        return { contactId: contact.id, discarded: true, reason: "mapping_missing" };
      }

      const updated = await updateContact(contact.id, {
        assigned_advisor_id: membership.id,
        last_whaapy_activity_at: ts,
      });

      // Propagar tag de vendedor al customer Shopify si está enlazado.
      await propagateVendorTagToShopify(updated, membership);

      return { contactId: updated.id, assignedAdvisorId: membership.id };
    });
  },
);

// ============================================================
// 3) conversation.unassigned
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
      const contact = await findContactByWhaapyContactId(data.contact_id);
      if (!contact) return { discarded: true, reason: "contact_unknown" };
      const ts = data.unassigned_at ?? env.receivedAt;
      await updateContact(contact.id, { last_whaapy_activity_at: ts });
      await recordAuditEvent({
        actorUserId: null,
        eventType: "whaapy_conversation_unassigned",
        entityType: "contact",
        entityId: contact.id,
        payload: { whaapy_conversation_id: data.id },
      });
      return { contactId: contact.id };
    });
  },
);

// ============================================================
// 4) conversation.closed
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
      const contact = await findContactByWhaapyContactId(data.contact_id);
      if (!contact) return { discarded: true, reason: "contact_unknown" };
      const ts = data.closed_at ?? env.receivedAt;
      await updateContact(contact.id, { last_whaapy_activity_at: ts });
      await recordAuditEvent({
        actorUserId: null,
        eventType: "whaapy_conversation_closed",
        entityType: "contact",
        entityId: contact.id,
        payload: { whaapy_conversation_id: data.id },
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
  // Buscar el tag mapping del vendedor (tag_mappings.mapped_membership_id).
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
    // Sin tag mapping no podemos propagar a Shopify; el vendedor
    // queda asignado en el maestro pero el customer Shopify no
    // recibe tag. Registrar para que el admin lo cargue desde M7.
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
