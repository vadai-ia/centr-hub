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
import { isEchoByCustomFieldMarker } from "@/lib/services/whaapy-echo-detection";
import { findActiveMembershipIdByWhaapyAgentId } from "@/lib/db/users";
import { decideAgentAdvisorSync } from "@/lib/services/whaapy-agent-sync";
import {
  createContact,
  findContactByWhaapyContactId,
  updateContact,
} from "@/lib/db/contacts";
import { recordAuditEvent } from "@/lib/db/operational";
import { evaluateAndCreateC2Opportunity } from "@/lib/services/r12-auto-creation";
import { archiveContactForWhaapyDeletion } from "@/lib/services/whaapy-contact-archival";
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

      // Asesor mapeado desde el agente de Whaapy (bug 2): un contacto que
      // entra desde Whaapy con agente asignado debe aterrizar CON asesor en
      // la plataforma. Se resuelve `assigned_agent_id` → membership por
      // `memberships.whaapy_agent_id`. Null si el evento no trae agente o el
      // agente no está mapeado a un vendedor activo. R2: nunca roba un asesor
      // ya asignado — solo rellena cuando el contacto no tiene.
      const advisorFromAgent = data.assigned_agent_id
        ? await findActiveMembershipIdByWhaapyAgentId(env.organizationId, data.assigned_agent_id)
        : null;

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
          assigned_advisor_id: advisorFromAgent,
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

      // 1.5 R11 opción B (timestamp) — ANTES de la hidratación LWW, que
      //     sobreescribe `last_modified_source='platform'` (el marcador que
      //     dejó el outbound). El `contact.created` de Whaapy NO trae el
      //     custom_field marker (la opción A de abajo falla ahí), así que
      //     esta capa de timestamp es la que ataja el eco de nuestro propio
      //     POST /contacts/v1 → sin ella R12 crea un "Lead nuevo" duplicado.
      //     (El worker de contact.updated ya usa esta misma defensa.)
      const isEchoTimestamp = await discardIfOwnEcho({
        contactId: contact.id,
        payloadUpdatedAt: effectiveUpdatedAt,
        source: "whaapy",
        whaapyEntityId: data.contact_id,
      });
      if (isEchoTimestamp) {
        await updateContact(contact.id, { last_whaapy_activity_at: env.receivedAt });
        return { contactId: contact.id, discarded: true, reason: "sync_loop_prevented", r12Suppressed: true };
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
      // Bug 2 (rama matched): si el contacto ya existía sin asesor y Whaapy
      // trae un agente mapeado, sellar el asesor (fill-if-null, R2 no roba).
      if (contact.assigned_advisor_id === null && advisorFromAgent) {
        finalPatch.assigned_advisor_id = advisorFromAgent;
      }
      const updated = await updateContact(contact.id, finalPatch);

      // 3. R11 opción A — eco de nuestro propio outbound. Si el payload
      //    trae `custom_fields.last_platform_write_at` reciente, este
      //    contact.created es el espejo del POST /contacts/v1 que M3
      //    encoló desde Shopify → Whaapy (asimetría v5.1). NO es un
      //    lead orgánico de WhatsApp — suprimimos R12.
      //
      //    El contact local YA quedó hidratado por los pasos 1 y 2
      //    (identity match + LWW), así que solo se omite la creación
      //    de la oportunidad sintética "Lead nuevo".
      const isEcho = isEchoByCustomFieldMarker(
        data.custom_fields,
        env.receivedAt,
      );
      if (isEcho) {
        await recordAuditEvent({
          actorUserId: null,
          eventType: "sync_loop_prevented",
          entityType: "contact",
          entityId: updated.id,
          payload: {
            source: "whaapy",
            whaapy_entity_id: data.contact_id,
            reason: "custom_field_marker_match_on_created",
            marker_field: WHAAPY_OUTBOUND_MARKER_FIELD,
            marker_value:
              (data.custom_fields as Record<string, unknown> | null | undefined)?.[
                WHAAPY_OUTBOUND_MARKER_FIELD
              ] ?? null,
            suppressed: "r12_auto_creation",
          } as Json,
        });
        return {
          contactId: updated.id,
          linked: !!match.match,
          r12Suppressed: true,
        };
      }

      // 4. R12 (a): contacto nuevo entra a Whaapy → opp en Lead nuevo.
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
          `/contacts/v1/${data.contact_id}`,
        );
        snapshot = WhaapyContactGetResponseSchema.parse(raw).contact;
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
      if (isEchoByCustomFieldMarker(snapshot.custom_fields, env.receivedAt)) {
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

      // 4b. Sync del AGENTE de Whaapy → asesor de la plataforma (dirección
      //     Whaapy→plataforma para contactos EXISTENTES; el `contact.created`
      //     ya cubre los nuevos). Solo actúa cuando Whaapy señala que el
      //     agente cambió (`updated_fields` incluye "assignedAgentId") — un
      //     cambio de nombre/email NO toca el asesor. Corre DESPUÉS de las
      //     defensas de eco (3a/3b): sólo un cambio GENUINO de Whaapy llega
      //     aquí, nunca el eco de una escritura propia de la plataforma (por
      //     eso no reasigna en bucle). `assigned_agent_id` viene del snapshot
      //     del GET (el delta del webhook no lo trae). R2 intacto: solo toca
      //     el CONTACTO, no la opp. La decisión pura vive en
      //     `decideAgentAdvisorSync` (testeable).
      const agentFieldChanged = data.updated_fields.includes("assignedAgentId");
      const snapshotAgentId = agentFieldChanged ? snapshot.assigned_agent_id ?? null : null;
      const mappedMembershipId =
        agentFieldChanged && snapshotAgentId
          ? await findActiveMembershipIdByWhaapyAgentId(env.organizationId, snapshotAgentId)
          : null;
      const agentDecision = decideAgentAdvisorSync({
        agentFieldChanged,
        snapshotAgentId,
        currentAdvisorId: contact.assigned_advisor_id,
        mappedMembershipId,
      });
      if (agentDecision.changed) {
        finalPatch.assigned_advisor_id = agentDecision.nextAdvisorId;
      }

      const updated = await updateContact(contact.id, finalPatch);
      if (agentDecision.audit === "synced") {
        await recordAuditEvent({
          actorUserId: null,
          eventType: "whaapy_agent_advisor_synced",
          entityType: "contact",
          entityId: updated.id,
          payload: {
            whaapy_agent_id: snapshotAgentId,
            from_membership_id: contact.assigned_advisor_id,
            to_membership_id: agentDecision.nextAdvisorId,
          } as Json,
        });
      } else if (agentDecision.audit === "mapping_missing") {
        await recordAuditEvent({
          actorUserId: null,
          eventType: "whaapy_agent_mapping_missing",
          entityType: "contact",
          entityId: updated.id,
          payload: { whaapy_agent_id: snapshotAgentId, whaapy_entity_id: data.contact_id } as Json,
        });
      }

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
// 3) contact.deleted → archivado propagado (Fix A)
// ============================================================
//
// Borrar en Whaapy ARCHIVA el contacto en la plataforma (nunca borrado
// físico): marca `deleted_in_whaapy`, cancela las opps NO terminales,
// y etiqueta el customer Shopify si está enlazado. La lógica vive en el
// servicio compartido `archiveContactForWhaapyDeletion` — el mismo que
// reusa el correctivo, garantizando semántica idéntica.

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
      const result = await archiveContactForWhaapyDeletion({
        contact,
        deletedAt: ts,
        source: "whaapy_webhook",
      });

      // Whaapy emitió el webhook → registró actividad del lado
      // conversacional. Se persiste en todos los caminos (incluido
      // re-proceso idempotente), igual que en updated/created.
      await updateContact(contact.id, { last_whaapy_activity_at: env.receivedAt });

      return {
        contactId: result.contactId,
        cancelledOpportunityIds: result.cancelledOpportunityIds,
        shopifyTagged: result.shopifyTagged,
      };
    });
  },
);

// ============================================================
// helpers privados
// ============================================================

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
