import "server-only";
import { getCurrentOrganizationId } from "@/lib/tenant/context";
import {
  matchContactIdentity,
  normalizeEmail,
  normalizePhone,
} from "@/lib/services/identity-matching";
import {
  reconcileContactFields,
  type FieldProposal,
} from "@/lib/services/last-write-wins";
import { findActiveMembershipIdByWhaapyAgentId } from "@/lib/db/users";
import { createContact, updateContact } from "@/lib/db/contacts";
import { recordAuditEvent } from "@/lib/db/operational";
import type { ContactRow, Json, UUID } from "@/lib/types/database";

/**
 * Ingesta CANÓNICA de un contacto de Whaapy al maestro: identity-match →
 * crea/enlaza → mapea agente→asesor → hidrata LWW. Fuente única usada por el
 * worker `conversation.created` (leads orgánicos que Whaapy NO emite como
 * `contact.created`) y por el backfill de recuperación. Reusa exactamente el
 * mismo matching/mapeo/LWW que el worker `contact.created`.
 *
 * NO evalúa R12 ni defensas de eco — eso lo decide el caller (un
 * conversation.created de un writer orgánico no es eco propio; el backfill
 * corre en frío). R2: el asesor solo se rellena si el contacto no tenía
 * (fill-if-null) o si nace nuevo desde el agente.
 *
 * Debe correr DENTRO de un `withTenantContext`.
 */
export interface WhaapyContactIngestInput {
  whaapyContactId: string;
  phone: string | null;
  name: string | null;
  email: string | null;
  address: Json | null;
  /** Agente de Whaapy (assigned_agent_id) — se mapea a membership. */
  assignedAgentId: string | null;
  /** Timestamp efectivo del cambio (para LWW). */
  effectiveUpdatedAt: string;
  /** Momento de recepción del evento (last_whaapy_activity_at). */
  receivedAt: string;
}

export interface WhaapyContactIngestResult {
  contact: ContactRow;
  created: boolean;
  /** Membership resuelto desde el agente (null si sin agente o sin mapeo). */
  advisorFromAgent: UUID | null;
}

export async function ingestWhaapyContact(
  input: WhaapyContactIngestInput,
): Promise<WhaapyContactIngestResult> {
  const organizationId = getCurrentOrganizationId();

  const match = await matchContactIdentity({
    source: "whaapy",
    whaapyContactId: input.whaapyContactId,
    phone: input.phone ?? null,
    email: input.email ?? null,
  });

  // Asesor mapeado desde el agente de Whaapy (bug 2). Null si no trae agente
  // o el agente no mapea a un vendedor activo.
  const advisorFromAgent = input.assignedAgentId
    ? await findActiveMembershipIdByWhaapyAgentId(organizationId, input.assignedAgentId)
    : null;

  let contact: ContactRow;
  let created = false;
  let isInitialMatch = false;

  if (match.match) {
    contact = match.match;
    if (!contact.whaapy_contact_id) {
      contact = await updateContact(contact.id, {
        whaapy_contact_id: input.whaapyContactId,
      });
      isInitialMatch = true;
      await recordAuditEvent({
        actorUserId: null,
        eventType: "identity_linked_whaapy",
        entityType: "contact",
        entityId: contact.id,
        payload: { external_id: input.whaapyContactId },
      });
    }
  } else {
    contact = await createContact({
      full_name: input.name ?? null,
      email: normalizeEmail(input.email ?? null),
      phone: normalizePhone(input.phone ?? null, "MX"),
      address: input.address ?? null,
      internal_note: null,
      shopify_state: null,
      shopify_tags: [],
      assigned_advisor_id: advisorFromAgent,
      shopify_customer_id: null,
      whaapy_contact_id: input.whaapyContactId,
      missing_phone: normalizePhone(input.phone ?? null) === null,
      field_metadata: {} as Json,
      last_modified_at: input.effectiveUpdatedAt,
      last_modified_source: "whaapy",
      deleted_in_shopify: false,
      deleted_in_whaapy: false,
      anonymized_at: null,
      last_whaapy_activity_at: null,
    });
    created = true;
  }

  // LWW por campo con los datos del evento/snapshot.
  const proposals: FieldProposal[] = [
    { field: "full_name", value: input.name ?? null,                          updatedAt: input.effectiveUpdatedAt, source: "whaapy" },
    { field: "email",     value: normalizeEmail(input.email ?? null),          updatedAt: input.effectiveUpdatedAt, source: "whaapy" },
    { field: "phone",     value: normalizePhone(input.phone ?? null, "MX"),    updatedAt: input.effectiveUpdatedAt, source: "whaapy" },
    { field: "address",   value: input.address ?? null,                        updatedAt: input.effectiveUpdatedAt, source: "whaapy" },
  ];
  const reconciled = reconcileContactFields(contact, proposals, { isInitialMatch });
  const phoneFinal = normalizePhone(input.phone ?? null);
  const finalPatch: Record<string, unknown> = {
    ...reconciled.patch,
    field_metadata: reconciled.nextFieldMetadata,
    last_modified_at: input.effectiveUpdatedAt,
    last_modified_source: "whaapy",
    last_whaapy_activity_at: input.receivedAt,
    missing_phone: phoneFinal === null,
  };
  // Fill-if-null del asesor desde el agente (R2 nunca roba un asesor puesto).
  if (contact.assigned_advisor_id === null && advisorFromAgent) {
    finalPatch.assigned_advisor_id = advisorFromAgent;
  }
  const updated = await updateContact(contact.id, finalPatch);
  return { contact: updated, created, advisorFromAgent };
}
