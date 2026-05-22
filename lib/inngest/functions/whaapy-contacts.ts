import "server-only";
import {
  getInngestClient,
  type WhaapyWebhookEnvelope,
} from "@/lib/inngest/client";
import { runWhaapyWebhookWorker } from "@/lib/inngest/helpers";
import {
  WhaapyContactCreatedPayloadSchema,
  WhaapyContactUpdatedPayloadSchema,
  WhaapyContactDeletedPayloadSchema,
  WhaapyContactGetResponseSchema,
  type WhaapyContactSnapshot,
} from "@/lib/whaapy/mappers";
import { whaapyRest } from "@/lib/whaapy/admin-client";
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
  findContactByWhaapyContactId,
  updateContact,
} from "@/lib/db/contacts";
import { recordAuditEvent } from "@/lib/db/operational";
import { evaluateAndCreateC2Opportunity } from "@/lib/services/r12-auto-creation";
import { updateCustomer } from "@/lib/shopify/outbound";
import { WHAAPY_OUTBOUND_MARKER_FIELD } from "@/lib/whaapy/config";
import type {
  ContactRow,
  Json,
  UUID,
} from "@/lib/types/database";

/**
 * Workers de Sincronización Whaapy → contactos (M4).
 *
 * Topics:
 *   - contact.created → identity matching + creación/enlace + R12 (a).
 *   - contact.updated → GET reconcile + LWW por campo + propaga a Shopify.
 *   - contact.deleted → soft-delete (deleted_in_whaapy=true). NO propaga.
 *
 * Defensa anti-bucle R11: opción B (timestamps + last_modified_source).
 * Capa adicional opcional A: marker en `custom_fields.last_platform_write_at`
 * que viaja en outbound y que el GET de reconciliación devuelve. Si
 * está presente y reciente, descartamos como eco antes del LWW.
 */

const inngest = getInngestClient();

// ============================================================
// 1) contact.created
// ============================================================

export const whaapyContactCreated = inngest.createFunction(
  {
    id: "whaapy-contact-created",
    retries: 5,
    triggers: [{ event: "whaapy/contact.created" }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as WhaapyWebhookEnvelope;
    return runWhaapyWebhookWorker(envelope, "contact.created", async (env) => {
      const parsed = WhaapyContactCreatedPayloadSchema.parse(env.payload);
      const data = parsed.data;
      const effectiveUpdatedAt =
        data.updated_at ?? data.created_at ?? env.receivedAt;

      // 1. Identity matching
      const match = await matchContactIdentity({
        source: "whaapy",
        whaapyContactId: data.contact_id,
        phone: data.phone_number ?? null,
        email: data.email ?? null,
      });

      let contact: ContactRow;
      let isInitialMatch = false;

      if (match.match) {
        contact = match.match;
        if (!contact.whaapy_contact_id) {
          contact = await updateContact(contact.id, {
            whaapy_contact_id: data.contact_id,
          });
          isInitialMatch = true;
          await recordAuditEvent({
            actorUserId: null,
            eventType: "identity_linked_whaapy",
            entityType: "contact",
            entityId: contact.id,
            payload: { external_id: data.contact_id },
          });
        }
      } else {
        // Asimetría v5.1: NO crear customer Shopify desde acá.
        contact = await createContact({
          full_name: data.name ?? null,
          email: normalizeEmail(data.email ?? null),
          phone: normalizePhone(data.phone_number ?? null, "MX"),
          address: (data.address ?? null) as Json | null,
          internal_note: null,
          shopify_state: null,
          shopify_tags: [],
          assigned_advisor_id: null,
          shopify_customer_id: null,
          whaapy_contact_id: data.contact_id,
          missing_phone: normalizePhone(data.phone_number ?? null) === null,
          field_metadata: {} as Json,
          last_modified_at: effectiveUpdatedAt,
          last_modified_source: "whaapy",
          deleted_in_shopify: false,
          deleted_in_whaapy: false,
          anonymized_at: null,
          last_whaapy_activity_at: null,
        });
      }

      // 2. LWW por campo con los datos que vinieron en el payload.
      const proposals: FieldProposal[] = [
        { field: "full_name",     value: data.name,                              updatedAt: effectiveUpdatedAt, source: "whaapy" },
        { field: "email",         value: normalizeEmail(data.email ?? null),     updatedAt: effectiveUpdatedAt, source: "whaapy" },
        { field: "phone",         value: normalizePhone(data.phone_number ?? null, "MX"), updatedAt: effectiveUpdatedAt, source: "whaapy" },
        { field: "address",       value: data.address ?? null,                   updatedAt: effectiveUpdatedAt, source: "whaapy" },
      ];
      const reconciled = reconcileContactFields(contact, proposals, { isInitialMatch });
      const finalPatch: Record<string, unknown> = {
        ...reconciled.patch,
        field_metadata: reconciled.nextFieldMetadata,
        last_modified_at: effectiveUpdatedAt,
        last_modified_source: "whaapy",
        last_whaapy_activity_at: env.receivedAt,
      };
      const phoneFinal = normalizePhone(data.phone_number ?? null);
      finalPatch.missing_phone = phoneFinal === null;
      const updated = await updateContact(contact.id, finalPatch);

      // 3. R12 (a): contacto nuevo entra a Whaapy → opp en Lead nuevo.
      await evaluateAndCreateC2Opportunity({
        contact: updated,
        trigger: "new_contact_in_whaapy",
        triggeredByEvent: "contact.created",
        previousActivityAt: contact.last_modified_at ?? null,
        currentActivityAt: env.receivedAt,
      });

      return { contactId: updated.id, linked: !!match.match };
    });
  },
);

// ============================================================
// 2) contact.updated
// ============================================================

export const whaapyContactUpdated = inngest.createFunction(
  {
    id: "whaapy-contact-updated",
    retries: 5,
    triggers: [{ event: "whaapy/contact.updated" }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as WhaapyWebhookEnvelope;
    return runWhaapyWebhookWorker(envelope, "contact.updated", async (env) => {
      const parsed = WhaapyContactUpdatedPayloadSchema.parse(env.payload);
      const data = parsed.data;
      const effectiveUpdatedAt = data.updated_at ?? env.receivedAt;

      // 1. Localizar contact local. Si no existe, fallback create
      //    (matching via id Whaapy nada más — sin teléfono podemos
      //    hacer poco; se completa con el GET reconcile).
      let contact = await findContactByWhaapyContactId(data.contact_id);
      if (!contact) {
        contact = await createContact({
          full_name: data.name ?? null,
          email: null,
          phone: null,
          address: null,
          internal_note: null,
          shopify_state: null,
          shopify_tags: [],
          assigned_advisor_id: null,
          shopify_customer_id: null,
          whaapy_contact_id: data.contact_id,
          missing_phone: true,
          field_metadata: {} as Json,
          last_modified_at: effectiveUpdatedAt,
          last_modified_source: "whaapy",
          deleted_in_shopify: false,
          deleted_in_whaapy: false,
          anonymized_at: null,
          last_whaapy_activity_at: null,
        });
      }

      // 2. GET de reconciliación PRIMERO — Whaapy NO envía snapshot en
      //    updated. El GET debe correr ANTES de R11 para poder validar
      //    el marker custom_field (opción A) y dar a la opción B su
      //    snapshot de referencia. Costo: una API call por webhook eco
      //    (aceptado para no incurrir en falsos positivos por timing
      //    sin posibilidad de cross-check con el marker).
      //    Fallo del GET → audit log + throw → Inngest retry → DLQ.
      //    Maestro queda en estado pre-webhook hasta éxito.
      let snapshot: WhaapyContactSnapshot;
      try {
        const raw = await whaapyRest<unknown>(
          { organizationId: env.organizationId },
          "GET",
          `/contacts/${data.contact_id}`,
        );
        snapshot = WhaapyContactGetResponseSchema.parse(raw);
      } catch (err) {
        await recordAuditEvent({
          actorUserId: null,
          eventType: "whaapy_reconciliation_failed",
          entityType: "contact",
          entityId: contact.id,
          payload: {
            whaapy_contact_id: data.contact_id,
            error: (err as Error).message,
          },
        });
        throw err;
      }

      // 3a. R11 opción B: timestamp + last_modified_source='platform'.
      //     Cualquier eco actualiza last_whaapy_activity_at antes de
      //     retornar — Whaapy emitió el webhook, hay actividad del
      //     lado conversacional aunque el cambio sea eco propio.
      const isEchoTimestamp = await discardIfOwnEcho({
        contactId: contact.id,
        payloadUpdatedAt: effectiveUpdatedAt,
        source: "whaapy",
        whaapyEntityId: data.contact_id,
      });
      if (isEchoTimestamp) {
        await updateContact(contact.id, {
          last_whaapy_activity_at: env.receivedAt,
        });
        return { contactId: contact.id, discarded: true, reason: "sync_loop_prevented" };
      }

      // 3b. R11 opción A: marker custom_field. Si el GET trae
      //     `last_platform_write_at` reciente, es eco — descartar.
      if (isEchoByCustomFieldMarker(snapshot, env.receivedAt)) {
        await recordAuditEvent({
          actorUserId: null,
          eventType: "sync_loop_prevented",
          entityType: "contact",
          entityId: contact.id,
          payload: {
            source: "whaapy",
            whaapy_entity_id: data.contact_id,
            reason: "custom_field_marker_match",
            marker_field: WHAAPY_OUTBOUND_MARKER_FIELD,
            marker_value: snapshot.custom_fields?.[WHAAPY_OUTBOUND_MARKER_FIELD] ?? null,
          } as Json,
        });
        await updateContact(contact.id, {
          last_whaapy_activity_at: env.receivedAt,
        });
        return { contactId: contact.id, discarded: true, reason: "sync_loop_prevented_marker" };
      }

      // 4. LWW por campo con snapshot completo.
      const proposals: FieldProposal[] = [
        { field: "full_name",     value: snapshot.name ?? null,                                       updatedAt: effectiveUpdatedAt, source: "whaapy" },
        { field: "email",         value: normalizeEmail(snapshot.email ?? null),                     updatedAt: effectiveUpdatedAt, source: "whaapy" },
        { field: "phone",         value: normalizePhone(snapshot.phone_number ?? null, "MX"),        updatedAt: effectiveUpdatedAt, source: "whaapy" },
        { field: "address",       value: (snapshot.address ?? null) as Json | null,                   updatedAt: effectiveUpdatedAt, source: "whaapy" },
      ];
      const reconciled = reconcileContactFields(contact, proposals, { isInitialMatch: false });
      const lwwChangedSomething = Object.keys(reconciled.patch).length > 0;

      const phoneFinal = normalizePhone(snapshot.phone_number ?? null);
      const finalPatch: Record<string, unknown> = {
        ...reconciled.patch,
        field_metadata: reconciled.nextFieldMetadata,
        last_modified_at: effectiveUpdatedAt,
        last_modified_source: "whaapy",
        last_whaapy_activity_at: env.receivedAt,
        missing_phone: phoneFinal === null,
      };
      const updated = await updateContact(contact.id, finalPatch);

      // 5. Propagación a Shopify SOLO si LWW efectivamente cambió algún
      //    campo. Si nada cambió (snapshot trae los mismos valores que
      //    el maestro o son más viejos por LWW), no hay nada que
      //    propagar — evita PUT redundante a Shopify Admin API.
      //    También se omite si missing_phone o sin shopify_customer_id
      //    (filtrado dentro de propagateUpdateToShopify).
      if (lwwChangedSomething) {
        await propagateUpdateToShopify(updated, snapshot);
      }

      return { contactId: updated.id, lwwApplied: lwwChangedSomething };
    });
  },
);

// ============================================================
// 3) contact.deleted (soft + NO propaga a Shopify — R8)
// ============================================================

export const whaapyContactDeleted = inngest.createFunction(
  {
    id: "whaapy-contact-deleted",
    retries: 3,
    triggers: [{ event: "whaapy/contact.deleted" }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as WhaapyWebhookEnvelope;
    return runWhaapyWebhookWorker(envelope, "contact.deleted", async (env) => {
      const parsed = WhaapyContactDeletedPayloadSchema.parse(env.payload);
      const contact = await findContactByWhaapyContactId(parsed.data.contact_id);
      if (!contact) return { discarded: true, reason: "not_local" };

      const ts = parsed.data.deleted_at ?? env.receivedAt;
      const updated = await updateContact(contact.id, {
        deleted_in_whaapy: true,
        last_modified_at: ts,
        last_modified_source: "whaapy",
        last_whaapy_activity_at: env.receivedAt,
      });
      return { contactId: updated.id };
    });
  },
);

// ============================================================
// helpers privados
// ============================================================

function isEchoByCustomFieldMarker(
  snapshot: WhaapyContactSnapshot,
  receivedAt: string,
): boolean {
  const cf = snapshot.custom_fields;
  if (!cf || typeof cf !== "object") return false;
  const raw = (cf as Record<string, unknown>)[WHAAPY_OUTBOUND_MARKER_FIELD];
  if (typeof raw !== "string") return false;
  const markerTs = new Date(raw).getTime();
  if (!Number.isFinite(markerTs)) return false;
  const receivedTs = new Date(receivedAt).getTime();
  // Si el marker es <= receivedAt y dentro de una ventana de 5 minutos
  // hacia atrás, lo tratamos como nuestra escritura. Margen mayor que
  // la ventana de la opción B (30s) — la opción A cubre los casos donde
  // los timestamps no se alinearon por la latencia del GET reconcile.
  const deltaMs = receivedTs - markerTs;
  return deltaMs >= 0 && deltaMs <= 5 * 60 * 1000;
}

async function propagateUpdateToShopify(
  contact: ContactRow,
  snapshot: WhaapyContactSnapshot,
): Promise<void> {
  if (!contact.shopify_customer_id) return;
  if (contact.missing_phone) return;

  // Solo propagamos los campos editables que LWW pudo cambiar — para
  // el MVP enviamos name/email/phone derivados del snapshot. Tags y
  // address quedan diferidos (V2: composition de partes de address en
  // formato Shopify; tags ya tienen ciclo propio en Shopify).
  const [firstName, ...rest] = (snapshot.name ?? "").trim().split(/\s+/);
  const lastName = rest.join(" ");

  try {
    // El cliente outbound Shopify de M3 maneja:
    //   - marca outbound (R11) ANTES del PUT,
    //   - supresión durante backfill,
    //   - audit log `shopify_customer_updated_outbound`.
    // Reutilizamos directamente — no reimplementamos.
    const shopDomain = await resolveShopDomainOrSkip(contact.organization_id);
    if (!shopDomain) return;
    await updateCustomer({
      ctx: { organizationId: contact.organization_id, shopDomain },
      contactId: contact.id,
      shopifyCustomerId: contact.shopify_customer_id,
      fields: {
        first_name: firstName || null,
        last_name: lastName || null,
        email: snapshot.email ?? null,
        phone: snapshot.phone_number ?? null,
      },
    });
  } catch (err) {
    // Failure de propagación se registra pero NO bloquea el worker.
    // El maestro local quedó correcto. Inngest podría haber reintentado
    // este worker entero — pero la propagación es side-effect, no
    // requisito del happy path local.
    await recordAuditEvent({
      actorUserId: null,
      eventType: "shopify_propagation_from_whaapy_failed",
      entityType: "contact",
      entityId: contact.id,
      payload: {
        shopify_customer_id: contact.shopify_customer_id,
        error: (err as Error).message,
      } as Json,
    });
  }
}

async function resolveShopDomainOrSkip(orgId: UUID): Promise<string | null> {
  const { getOrganizationById } = await import("@/lib/db/organizations");
  const org = await getOrganizationById(orgId);
  return org?.shopify_store_domain ?? null;
}

export const whaapyContactFunctions = [
  whaapyContactCreated,
  whaapyContactUpdated,
  whaapyContactDeleted,
];
