import "server-only";
import {
  getInngestClient,
  WHAAPY_OUTBOUND_CONTACT_SYNC_EVENT,
  type WhaapyContactSyncEnvelope,
} from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import {
  whaapyRest,
  whaapyRestWith409,
  WhaapyApiError,
} from "@/lib/whaapy/admin-client";
import { WHAAPY_OUTBOUND_MARKER_FIELD } from "@/lib/whaapy/config";
import {
  getContactById,
  updateContact,
} from "@/lib/db/contacts";
import { recordAuditEvent } from "@/lib/db/operational";
import { getOrganizationById } from "@/lib/db/organizations";
import { markOutboundWrite } from "@/lib/services/sync-loop-defense";
import { PLATFORM_ORIGIN_MARKER } from "@/lib/constants";
import { getTenantScopedClient } from "@/lib/db/client";
import type { Json, MembershipRow, UUID } from "@/lib/types/database";

/**
 * Worker outbound: consume eventos
 * `whaapy/outbound.contact_sync_requested` emitidos por:
 *   - workers Shopify M3 (cuando un customer cambia y debe propagarse).
 *   - M6 (futuro, edición manual de contacto) — mismo `reason: "update_from_shopify"`
 *     o `"update_from_platform_ui"` que este worker trata igual.
 *
 * Reasons soportados:
 *   - "create_from_shopify"      → POST /contacts/v1 (maneja 409 enlazando).
 *   - "create_from_platform_ui"  → mismo flujo de create que create_from_shopify
 *                                  (lead nacido en la plataforma — manual/webhook).
 *   - "update_from_shopify"      → PATCH /contacts/v1/{id}.
 *   - "update_from_platform_ui"  → mismo flujo que update_from_shopify.
 *
 * R11 defensa anti-bucle:
 *   - markOutboundWrite ANTES del POST/PATCH (opción B, timestamp local).
 *   - custom_fields.last_platform_write_at en el body (opción A, marker
 *     remoto que aparece en el GET reconcile y se descarta como eco).
 *
 * Fallo de la API saliente → throw → Inngest reintenta con backoff.
 * Tras agotar retries, dlq handler (M3) emite alerta admin. Maestro
 * local queda en estado correcto — solo propagación pendiente.
 *
 * `BackfillSuppressedError`: durante backfill se SUPRIME outbound
 * Whaapy (espejo de la supresión Shopify). El evento entra a Inngest
 * pero el worker lo descarta + audit log.
 */

const inngest = getInngestClient();

export const whaapyOutboundContactSync = inngest.createFunction(
  {
    id: "whaapy-outbound-contact-sync",
    retries: 5,
    triggers: [{ event: WHAAPY_OUTBOUND_CONTACT_SYNC_EVENT }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as WhaapyContactSyncEnvelope;
    return withTenantContext(
      envelope.organizationId,
      async () => {
        // 1. Validar supresión por backfill (espejo del check Shopify).
        const org = await getOrganizationById(envelope.organizationId);
        if (!org) {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "whaapy_outbound_failed",
            entityType: "contact",
            entityId: envelope.contactId,
            payload: { reason: "organization_not_found" },
          });
          return { discarded: true, reason: "organization_not_found" };
        }
        const backfill = (org as unknown as { backfill_in_progress?: boolean })
          .backfill_in_progress;
        if (backfill === true) {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "whaapy_outbound_suppressed_backfill",
            entityType: "contact",
            entityId: envelope.contactId,
            payload: { reason: envelope.reason },
          });
          return { discarded: true, reason: "backfill_in_progress" };
        }

        // 2. Pre-condiciones del snapshot.
        const snapshot = envelope.contactSnapshot;
        if (!snapshot.phone) {
          // Sin phone Whaapy no acepta el contacto. M6 lo gestionará
          // cuando el vendedor agregue teléfono.
          await recordAuditEvent({
            actorUserId: null,
            eventType: "whaapy_outbound_skipped_missing_phone",
            entityType: "contact",
            entityId: envelope.contactId,
            payload: { reason: envelope.reason },
          });
          return { discarded: true, reason: "missing_phone" };
        }

        // 3. Marcar outbound localmente ANTES de la llamada (R11 opción B).
        await markOutboundWrite({
          contactId: envelope.contactId,
          source: PLATFORM_ORIGIN_MARKER,
        });

        // 4. Directiva del agente (tri-estado, bug 3):
        //    - asesor mapeado a whaapy_agent_id → set (mandar el id).
        //    - asesor NULL (desasignado) → clear en UPDATE (mandar null para
        //      vaciarlo en Whaapy; la doc de Whaapy acepta null para
        //      desasignar), omitir en CREATE (no hay nada que limpiar).
        //    - asesor presente pero SIN mapeo whaapy_agent_id → omit (no
        //      podemos setear y NO debemos borrar un agente válido por error).
        const isUpdate =
          envelope.reason === "update_from_shopify" ||
          envelope.reason === "update_from_platform_ui";
        const agent = await resolveAgentDirective(
          envelope.organizationId,
          snapshot.assignedAdvisorId,
          isUpdate,
        );

        const baseBody = buildOutboundBody(snapshot, agent);

        // 5. Ejecutar según reason.
        if (
          envelope.reason === "create_from_shopify" ||
          envelope.reason === "create_from_platform_ui"
        ) {
          return await runCreate(envelope, baseBody);
        }
        if (isUpdate) {
          return await runUpdate(envelope, baseBody);
        }

        await recordAuditEvent({
          actorUserId: null,
          eventType: "whaapy_outbound_unsupported_reason",
          entityType: "contact",
          entityId: envelope.contactId,
          payload: { reason: envelope.reason },
        });
        return { discarded: true, reason: "unsupported_reason" };
      },
      { source: "worker" },
    );
  },
);

export interface OutboundBody {
  name?: string;
  phone_number: string;
  email?: string;
  custom_fields: Record<string, unknown>;
  add_tags?: string[];
  assigned_agent_id?: string | null;
}

/**
 * Directiva tri-estado del agente en el body outbound (bug 3):
 *   - `set`   → mandar `assigned_agent_id: <id>` (asignar).
 *   - `clear` → mandar `assigned_agent_id: null` (DESASIGNAR — la doc de
 *               Whaapy dice "envía null para quitar la asignación"). Solo se
 *               usa en UPDATE; en CREATE no hay agente que limpiar.
 *   - `omit`  → NO incluir la clave (no tocar el agente en Whaapy).
 */
export type AgentDirective =
  | { kind: "set"; id: string }
  | { kind: "clear" }
  | { kind: "omit" };

/** Resuelve la directiva del agente según el asesor del snapshot + create/update. */
export async function resolveAgentDirective(
  organizationId: UUID,
  assignedAdvisorId: UUID | null | undefined,
  isUpdate: boolean,
): Promise<AgentDirective> {
  if (assignedAdvisorId) {
    const mapped = await resolveWhaapyAgentIdForMembership(
      organizationId,
      assignedAdvisorId,
    );
    return mapped ? { kind: "set", id: mapped } : { kind: "omit" };
  }
  // Sin asesor: en UPDATE limpiamos (null); en CREATE no hay nada que limpiar.
  return isUpdate ? { kind: "clear" } : { kind: "omit" };
}

/**
 * Body del outbound. Whaapy valida los campos de TEXTO opcionales (name,
 * email) como `string` y RECHAZA `null` con un 400 "Expected string, received
 * null" (solo `phone_number` es requerido) → esos se OMITEN cuando son null.
 * Ver ERRORES.md "Whaapy 400 por email:null en el body outbound".
 *
 * `assigned_agent_id` es la EXCEPCIÓN: Whaapy sí acepta `null` para
 * DESASIGNAR el agente (doc "envía null para quitar la asignación"). Por eso
 * usa la directiva tri-estado: set (id) / clear (null, en UPDATE) / omit. El
 * gap R3 "omitir = no cambiar" sigue aplicando a name/email/dirección.
 */
export function buildOutboundBody(
  snapshot: WhaapyContactSyncEnvelope["contactSnapshot"],
  agent: AgentDirective,
): OutboundBody {
  const body: OutboundBody = {
    phone_number: snapshot.phone as string,
    custom_fields: {
      [WHAAPY_OUTBOUND_MARKER_FIELD]: new Date().toISOString(),
    },
  };
  if (snapshot.fullName) body.name = snapshot.fullName;
  if (snapshot.email) body.email = snapshot.email;
  if (snapshot.shopifyTags && snapshot.shopifyTags.length > 0) {
    body.add_tags = snapshot.shopifyTags;
  }
  if (agent.kind === "set") {
    body.assigned_agent_id = agent.id;
  } else if (agent.kind === "clear") {
    body.assigned_agent_id = null;
  }
  // "omit" → no se incluye la clave.
  return body;
}

async function runCreate(
  envelope: WhaapyContactSyncEnvelope,
  body: OutboundBody,
): Promise<unknown> {
  const result = await withOutboundFailureAudit(envelope, "create", () =>
    whaapyRestWith409<{ contact?: { id?: string }; id?: string }>(
      { organizationId: envelope.organizationId },
      "POST",
      "/contacts/v1",
      body,
    ),
  );
  if (result.ok) {
    // La respuesta de create viene ENVUELTA: `{ contact: { id, ... } }` (no
    // flat `{id}`). Se lee `.contact.id` con fallback a `.id` por si cambia.
    const created = result.data;
    const createdId = created?.contact?.id ?? created?.id ?? null;
    if (!createdId) {
      await recordAuditEvent({
        actorUserId: null,
        eventType: "whaapy_outbound_failed",
        entityType: "contact",
        entityId: envelope.contactId,
        payload: { reason: "no_id_in_response", body_excerpt: stringifyExcerpt(created) } as Json,
      });
      throw new Error("whaapy_create_no_id_in_response");
    }
    await linkWhaapyContactId(envelope.contactId, createdId);
    await recordAuditEvent({
      actorUserId: null,
      eventType: "whaapy_contact_created_outbound",
      entityType: "contact",
      entityId: envelope.contactId,
      payload: { whaapy_contact_id: createdId },
    });
    return { contactId: envelope.contactId, whaapyContactId: createdId, created: true };
  }
  // 409 conflict: phone duplicado → enlazar al existing.
  const existing = extractExistingId(result.body);
  if (!existing) {
    await recordAuditEvent({
      actorUserId: null,
      eventType: "whaapy_outbound_409_without_existing_id",
      entityType: "contact",
      entityId: envelope.contactId,
      payload: { body_excerpt: stringifyExcerpt(result.body) } as Json,
    });
    throw new Error("whaapy_create_conflict_without_existing_id");
  }
  await linkWhaapyContactId(envelope.contactId, existing);
  await recordAuditEvent({
    actorUserId: null,
    eventType: "whaapy_contact_matched_existing_on_create",
    entityType: "contact",
    entityId: envelope.contactId,
    payload: { whaapy_contact_id: existing },
  });
  return {
    contactId: envelope.contactId,
    whaapyContactId: existing,
    created: false,
    alreadyExisted: true,
  };
}

async function runUpdate(
  envelope: WhaapyContactSyncEnvelope,
  body: OutboundBody,
): Promise<unknown> {
  const whaapyId = envelope.contactSnapshot.whaapyContactId;
  if (!whaapyId) {
    // Update_from_shopify pero el contact local no tiene whaapy_contact_id
    // — probablemente carrera con un contact.created todavía en cola.
    // Inngest retry mientras tanto.
    await recordAuditEvent({
      actorUserId: null,
      eventType: "whaapy_outbound_update_missing_whaapy_id",
      entityType: "contact",
      entityId: envelope.contactId,
      payload: { reason: envelope.reason },
    });
    throw new Error("whaapy_update_missing_whaapy_contact_id");
  }
  // PATCH solo lleva los campos del snapshot — Whaapy mergea custom_fields.
  // Para tags usamos `add_tags`/`remove_tags` (NO `tags`, que reemplaza todo).
  await withOutboundFailureAudit(envelope, "update", () =>
    whaapyRest<unknown>(
      { organizationId: envelope.organizationId },
      "PATCH",
      `/contacts/v1/${whaapyId}`,
      body,
    ),
  );
  await recordAuditEvent({
    actorUserId: null,
    eventType: "whaapy_contact_updated_outbound",
    entityType: "contact",
    entityId: envelope.contactId,
    payload: { whaapy_contact_id: whaapyId },
  });
  return { contactId: envelope.contactId, whaapyContactId: whaapyId };
}

async function linkWhaapyContactId(
  contactId: UUID,
  whaapyContactId: string,
): Promise<void> {
  const existing = await getContactById(contactId);
  if (!existing) return;
  if (existing.whaapy_contact_id === whaapyContactId) return;
  await updateContact(contactId, { whaapy_contact_id: whaapyContactId });
}

async function resolveWhaapyAgentIdForMembership(
  organizationId: UUID,
  membershipId: UUID,
): Promise<string | null> {
  const { supabase } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", membershipId)
    .maybeSingle();
  if (error) throw error;
  const row = data as MembershipRow | null;
  return row?.whaapy_agent_id ?? null;
}

function extractExistingId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const direct = obj.existing_contact_id;
  if (typeof direct === "string" && direct.length > 0) return direct;
  // Algunos providers anidan: { error: { existing_contact_id } }
  const err = obj.error;
  if (err && typeof err === "object") {
    const inner = (err as Record<string, unknown>).existing_contact_id;
    if (typeof inner === "string" && inner.length > 0) return inner;
  }
  return null;
}

function stringifyExcerpt(body: unknown): string {
  try {
    const s = JSON.stringify(body);
    return s.length > 500 ? `${s.slice(0, 500)}...` : s;
  } catch {
    return String(body).slice(0, 500);
  }
}

/**
 * Instrumentación de fallos del REST outbound (observabilidad). El cliente
 * lanza `WhaapyApiError` en cualquier respuesta no-2xx/no-409; antes ese throw
 * subía SIN dejar rastro en `audit_log` (el fallo solo era visible en el
 * dashboard de Inngest). Aquí se audita `whaapy_outbound_failed` con el status
 * HTTP + excerpt del body + reason/phase ANTES de re-lanzar, para diagnosticar
 * retries/DLQ desde la BD (lección "exit_reason auditable desde el 1er commit").
 */
async function withOutboundFailureAudit<T>(
  envelope: WhaapyContactSyncEnvelope,
  phase: "create" | "update",
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WhaapyApiError) {
      await recordAuditEvent({
        actorUserId: null,
        eventType: "whaapy_outbound_failed",
        entityType: "contact",
        entityId: envelope.contactId,
        payload: {
          reason: envelope.reason,
          phase,
          status: err.status,
          retriable: err.retriable,
          body_excerpt: stringifyExcerpt(err.body),
        } as Json,
      });
    }
    throw err;
  }
}

export const whaapyOutboundFunctions = [whaapyOutboundContactSync];
