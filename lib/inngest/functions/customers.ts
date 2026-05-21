import "server-only";
import {
  getInngestClient,
  WHAAPY_OUTBOUND_CONTACT_SYNC_EVENT,
  type ShopifyWebhookEnvelope,
  type WhaapyContactSyncEnvelope,
} from "@/lib/inngest/client";
import { runWebhookWorker } from "@/lib/inngest/helpers";
import {
  mapCustomerWebhookToNormalized,
  type NormalizedCustomer,
} from "@/lib/shopify/mappers";
import { parseShopifyTags } from "@/lib/services/tag-parser";
import {
  matchContactIdentity,
  normalizeEmail,
  normalizePhone,
} from "@/lib/services/identity-matching";
import {
  reconcileContactFields,
  type FieldProposal,
} from "@/lib/services/last-write-wins";
import { discardIfOwnEcho } from "@/lib/services/sync-loop-defense";
import {
  createContact,
  findContactByShopifyCustomerId,
  updateContact,
} from "@/lib/db/contacts";
import { recordAuditEvent } from "@/lib/db/operational";
import type { ContactRow, Json, UUID } from "@/lib/types/database";

/**
 * Workers de Sincronización Shopify → contactos (M3).
 *
 * Topics:
 *   - customers/create  → matchear o crear + LWW + parser tags +
 *                          intent de creación automática en Whaapy
 *                          (M4 procesa el outbound).
 *   - customers/update  → R11 defensa anti-bucle + LWW por campo +
 *                          intent de propagación a Whaapy.
 *   - customers/delete  → soft-delete (R8 — deleted_in_shopify=true).
 */

const inngest = getInngestClient();

function buildContactInsert(
  normalized: NormalizedCustomer,
  match: { normalizedPhone: string | null; normalizedEmail: string | null },
  effectiveUpdatedAt: string,
): Parameters<typeof createContact>[0] {
  return {
    full_name: normalized.fullName,
    email: match.normalizedEmail,
    phone: match.normalizedPhone,
    address: (normalized.address ?? null) as Json | null,
    internal_note: normalized.note,
    shopify_state: normalized.state,
    shopify_tags: normalized.tags,
    assigned_advisor_id: null,
    shopify_customer_id: normalized.shopifyCustomerId,
    whaapy_contact_id: null,
    missing_phone: match.normalizedPhone === null,
    field_metadata: {} as Json,
    last_modified_at: effectiveUpdatedAt,
    last_modified_source: "shopify",
    deleted_in_shopify: false,
    deleted_in_whaapy: false,
    anonymized_at: null,
  };
}

function buildFieldProposals(
  normalized: NormalizedCustomer,
  source: "shopify",
  effectiveUpdatedAt: string,
): FieldProposal[] {
  return [
    { field: "full_name",     value: normalized.fullName,                       updatedAt: effectiveUpdatedAt, source },
    { field: "email",         value: normalizeEmail(normalized.email),          updatedAt: effectiveUpdatedAt, source },
    { field: "phone",         value: normalizePhone(normalized.phone, "MX"),    updatedAt: effectiveUpdatedAt, source },
    { field: "address",       value: normalized.address,                        updatedAt: effectiveUpdatedAt, source },
    { field: "internal_note", value: normalized.note,                           updatedAt: effectiveUpdatedAt, source },
    { field: "shopify_state", value: normalized.state,                          updatedAt: effectiveUpdatedAt, source },
    { field: "shopify_tags",  value: normalized.tags,                           updatedAt: effectiveUpdatedAt, source },
  ];
}

async function applyAssignmentFromTags(
  contact: ContactRow,
  normalized: NormalizedCustomer,
): Promise<UUID | null> {
  const parseResult = await parseShopifyTags({
    rawTags: normalized.tags,
    source: "customer",
    shopifyEntityId: normalized.shopifyCustomerId,
  });
  if (parseResult.assignedMembership) {
    return parseResult.assignedMembership.id;
  }
  if (parseResult.multipleVendorTagsDetected) {
    await recordAuditEvent({
      actorUserId: null,
      eventType: "customer_assignment_blocked_multiple_vendor_tags",
      entityType: "contact",
      entityId: contact.id,
      payload: {
        shopify_customer_id: normalized.shopifyCustomerId,
        vendor_tags: parseResult.vendorTags.map((v) => v.normalized),
      },
    });
  }
  return null;
}

async function persistMissingPhoneFlag(
  contactId: UUID,
  phoneNormalized: string | null,
): Promise<void> {
  await updateContact(contactId, { missing_phone: phoneNormalized === null });
}

/**
 * Exportada para tests sintéticos. El caller dentro del worker es
 * el único uso de producción — se llama solo si la guardia de
 * asimetría v5.1 lo permite (ver llamadas en customersCreate y
 * customersUpdate).
 */
export async function recordWhaapySyncIntent(
  contact: ContactRow,
  reason: "create_from_shopify" | "update_from_shopify",
): Promise<void> {
  // 1) Audit log paralelo (trazabilidad histórica — Sección 3.3.7).
  //    NO reemplaza el evento Inngest; sirve para auditar "se intentó
  //    propagar X contacto Y en Z momento" sin depender del estado de
  //    la cola.
  await recordAuditEvent({
    actorUserId: null,
    eventType: "whaapy_sync_intent_recorded",
    entityType: "contact",
    entityId: contact.id,
    payload: { reason, has_phone: contact.phone !== null } as Json,
  });

  // 2) Evento Inngest — la cola REAL que M4 consume.
  //    Si M4 no existe todavía cuando M3 está en producción, los
  //    eventos se acumulan en la cola Inngest y se procesan al
  //    registrarse el worker `whaapy/outbound.contact_sync_requested`
  //    (pub/sub durable). El snapshot completo del contact viaja
  //    aquí para que M4 procese aunque el contact local cambie
  //    después — LWW reconcilia al aplicar el outbound.
  const envelope: WhaapyContactSyncEnvelope = {
    organizationId: contact.organization_id,
    contactId: contact.id,
    reason,
    contactSnapshot: {
      shopifyCustomerId: contact.shopify_customer_id,
      whaapyContactId: contact.whaapy_contact_id,
      fullName: contact.full_name,
      email: contact.email,
      phone: contact.phone,
      address: contact.address,
      internalNote: contact.internal_note,
      shopifyTags: contact.shopify_tags,
      shopifyState: contact.shopify_state,
      assignedAdvisorId: contact.assigned_advisor_id,
      fieldMetadata: contact.field_metadata,
      lastModifiedAt: contact.last_modified_at,
      lastModifiedSource: contact.last_modified_source,
    },
  };
  await inngest.send({
    name: WHAAPY_OUTBOUND_CONTACT_SYNC_EVENT,
    data: envelope,
  });
}

// ============================================================
// 1) customers/create
// ============================================================

export const customersCreate = inngest.createFunction(
  {
    id: "shopify-customers-create",
    retries: 5,
    triggers: [{ event: "shopify/customers.create" }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as ShopifyWebhookEnvelope;
    return runWebhookWorker(envelope, "customers/create", async (env) => {
      const normalized = mapCustomerWebhookToNormalized(env.payload);
      const effectiveUpdatedAt =
        normalized.updatedAt ?? normalized.createdAt ?? new Date().toISOString();

      // 1. Identity match
      const match = await matchContactIdentity({
        source: "shopify",
        shopifyCustomerId: normalized.shopifyCustomerId,
        phone: normalized.phone,
        email: normalized.email,
      });

      let contact: ContactRow;
      let isInitialMatch = false;

      if (match.match) {
        contact = match.match;
        const patch: Record<string, unknown> = {};
        if (!contact.shopify_customer_id) {
          patch.shopify_customer_id = normalized.shopifyCustomerId;
          isInitialMatch = true;
        }
        if (Object.keys(patch).length > 0) {
          contact = await updateContact(contact.id, patch);
        }
      } else if (match.recommendation === "create_new" || match.recommendation === "conflict_create_new") {
        contact = await createContact(
          buildContactInsert(normalized, match, effectiveUpdatedAt),
        );
      } else {
        const found = await findContactByShopifyCustomerId(normalized.shopifyCustomerId);
        if (!found) throw new Error("customers_create: match indicó update pero contact ausente");
        contact = found;
      }

      // 2. LWW por campo
      const proposals = buildFieldProposals(normalized, "shopify", effectiveUpdatedAt);
      const reconciled = reconcileContactFields(contact, proposals, { isInitialMatch });

      // 3. Asignación por tag
      const assignedAdvisorId = await applyAssignmentFromTags(contact, normalized);

      const finalPatch: Record<string, unknown> = {
        ...reconciled.patch,
        field_metadata: reconciled.nextFieldMetadata,
        last_modified_at: effectiveUpdatedAt,
        last_modified_source: "shopify",
      };
      if (assignedAdvisorId !== null && contact.assigned_advisor_id !== assignedAdvisorId) {
        finalPatch.assigned_advisor_id = assignedAdvisorId;
      }

      const updated = await updateContact(contact.id, finalPatch);
      await persistMissingPhoneFlag(updated.id, match.normalizedPhone);

      // 4. Asimetría v5.1: Shopify → Whaapy creación automática (intent)
      if (!updated.whaapy_contact_id && updated.phone) {
        await recordWhaapySyncIntent(updated, "create_from_shopify");
      }

      return { contactId: updated.id, created: !match.match };
    });
  },
);

// ============================================================
// 2) customers/update
// ============================================================

export const customersUpdate = inngest.createFunction(
  {
    id: "shopify-customers-update",
    retries: 5,
    triggers: [{ event: "shopify/customers.update" }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as ShopifyWebhookEnvelope;
    return runWebhookWorker(envelope, "customers/update", async (env) => {
      const normalized = mapCustomerWebhookToNormalized(env.payload);
      const effectiveUpdatedAt =
        normalized.updatedAt ?? new Date().toISOString();

      let contact = await findContactByShopifyCustomerId(normalized.shopifyCustomerId);
      if (!contact) {
        const matchResult = await matchContactIdentity({
          source: "shopify",
          phone: normalized.phone,
          email: normalized.email,
        });
        if (matchResult.match) {
          contact = await updateContact(matchResult.match.id, {
            shopify_customer_id: normalized.shopifyCustomerId,
          });
        } else {
          contact = await createContact(
            buildContactInsert(normalized, matchResult, effectiveUpdatedAt),
          );
        }
      }

      // R11: descartar si es eco propio
      const isEcho = await discardIfOwnEcho({
        contactId: contact.id,
        payloadUpdatedAt: effectiveUpdatedAt,
        source: "shopify",
        shopifyEntityId: normalized.shopifyCustomerId,
      });
      if (isEcho) {
        return { contactId: contact.id, discarded: true, reason: "sync_loop_prevented" };
      }

      const proposals = buildFieldProposals(normalized, "shopify", effectiveUpdatedAt);
      const reconciled = reconcileContactFields(contact, proposals, { isInitialMatch: false });
      const assignedAdvisorId = await applyAssignmentFromTags(contact, normalized);

      const finalPatch: Record<string, unknown> = {
        ...reconciled.patch,
        field_metadata: reconciled.nextFieldMetadata,
        last_modified_at: effectiveUpdatedAt,
        last_modified_source: "shopify",
      };
      if (assignedAdvisorId !== null && contact.assigned_advisor_id !== assignedAdvisorId) {
        finalPatch.assigned_advisor_id = assignedAdvisorId;
      }

      const updated = await updateContact(contact.id, finalPatch);
      await persistMissingPhoneFlag(updated.id, normalizePhone(normalized.phone));

      if (updated.whaapy_contact_id) {
        await recordWhaapySyncIntent(updated, "update_from_shopify");
      }
      return { contactId: updated.id };
    });
  },
);

// ============================================================
// 3) customers/delete  (R8 — soft-delete)
// ============================================================

export const customersDelete = inngest.createFunction(
  {
    id: "shopify-customers-delete",
    retries: 3,
    triggers: [{ event: "shopify/customers.delete" }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as ShopifyWebhookEnvelope;
    return runWebhookWorker(envelope, "customers/delete", async (env) => {
      const payload = env.payload as { id?: number | string };
      const shopifyId = payload?.id;
      if (shopifyId === undefined || shopifyId === null) {
        throw new Error("customers_delete: payload sin id");
      }
      const contact = await findContactByShopifyCustomerId(String(shopifyId));
      if (!contact) return { discarded: true, reason: "not_local" };

      const ts = new Date().toISOString();
      const updated = await updateContact(contact.id, {
        deleted_in_shopify: true,
        last_modified_at: ts,
        last_modified_source: "shopify",
      });
      return { contactId: updated.id };
    });
  },
);

export const customerFunctions = [customersCreate, customersUpdate, customersDelete];
