import "server-only";
import { getCurrentOrganizationId } from "@/lib/tenant/context";
import {
  matchLeadIdentity,
  normalizePhone,
  normalizeEmail,
} from "@/lib/services/identity-matching";
import { pickRoundRobinAdvisor } from "@/lib/services/lead-advisor-assignment";
import { isBlockingOpportunity } from "@/lib/services/r12-auto-creation";
import { getInitialStage } from "@/lib/db/pipeline";
import {
  createOpportunity,
  listOpportunities,
  recordStageChange,
} from "@/lib/db/opportunities";
import {
  createContact,
  getContactById,
  updateContact,
} from "@/lib/db/contacts";
import { listActiveRealVendors } from "@/lib/db/users";
import {
  recordActivity,
  recordAuditEvent,
  createNotification,
  listOrgAdminUserIds,
} from "@/lib/db/operational";
import { recordWhaapySyncIntent } from "@/lib/inngest/functions/customers";
import { setContactOutbound } from "@/lib/services/outbound-mark";
import { structuredAddressToJson } from "@/lib/contacts/address";
import type { StructuredAddress } from "@/lib/contacts/address";
import { DEFAULT_CURRENCY } from "@/lib/constants";
import type { ContactRow, Funnel, Json, UUID } from "@/lib/types/database";

/**
 * Camino CANÓNICO de creación de leads (Track 1).
 *
 * Ambas vías nuevas — creación manual desde la UI (Bloque A) y creación por
 * webhook de fuente externa (Bloque B) — llaman a `createLead`. Nada escribe
 * contactos/oportunidades "por atrás" saltándose estos efectos: un lead
 * creado por cualquier vía queda idéntico a uno del otro en todos sus
 * efectos (contacto, dedup, etapa inicial, asesor, auditoría, propagación
 * a Whaapy). Ver diagnóstico + doctrina v5.1 (R11/R12/O11/O12).
 *
 * Efectos:
 *   1. Dedup por identidad (`matchLeadIdentity`: phone→email; enlaza a lead
 *      O cliente existente en vez de duplicar — regla Duplicados).
 *   2. Resolución de asesor (manual: elegido; webhook: round-robin). NUNCA
 *      roba el asesor de un contacto que ya tiene dueño (R2).
 *   3. Oportunidad "Lead nuevo" en la etapa inicial de Funnel Venta, salvo
 *      que el contacto ya tenga una opp activa (se respeta — guard R12).
 *      El `message` del formulario nace como nota de esa opp y como actividad
 *      `lead_message` en la historia del contacto (esta última, incluso si se
 *      dedupeó sin opp nueva).
 *   4. Atribución de origen (`opportunities.lead_source` +
 *      `inbound_webhook_source_id`) + audit `lead_created` (cubre incluso el
 *      caso deduplicado-sin-opp-nueva).
 *   5. Creación/asignación del contacto en el Whaapy de Venta con su asesor
 *      (reason `create_from_platform_ui` o `update_from_platform_ui`).
 *      NUNCA crea en Shopify (sigue siendo manual — botón existente).
 */

export class LeadValidationError extends Error {
  constructor(
    public readonly code:
      | "missing_name"
      | "missing_phone"
      | "invalid_phone"
      | "advisor_not_eligible",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "LeadValidationError";
  }
}

export type LeadSource = "manual" | "webhook";

export type LeadAssignment =
  | { mode: "explicit"; advisorId: UUID | null }
  | { mode: "round_robin" };

export interface CreateLeadInput {
  fullName: string;
  phone: string;
  email?: string | null;
  address?: Partial<StructuredAddress> | null;
  assignment: LeadAssignment;
  source: LeadSource;
  /** Fuente de webhook concreta (Bloque B). NULL para leads manuales. */
  inboundWebhookSourceId?: UUID | null;
  /** Usuario que crea (manual). NULL para webhook (server-to-server). */
  actorUserId?: UUID | null;
  /**
   * Funnel donde nace el lead. Default "venta". "outbound" (Fase 2) lo crea
   * en el funnel Outbound del SDR, MARCA el contacto como outbound y propaga
   * la marca a sus opps no terminales. Como el SDR no es asesor asignable, la
   * opp Outbound nace sin asignar (el caller pasa assignment explícito null).
   */
  channel?: "venta" | "outbound";
  /**
   * Texto libre que escribió el lead en el formulario de origen (opcional).
   * Aterriza como nota de la oportunidad nueva y como actividad en la historia
   * del contacto — la actividad se registra AUNQUE se haya deduplicado sin opp
   * nueva, para que el mensaje nunca se pierda.
   */
  message?: string | null;
}

export interface CreateLeadResult {
  contactId: UUID;
  /** null si se respetó una oportunidad activa existente (no se creó nueva). */
  opportunityId: UUID | null;
  contactCreated: boolean;
  opportunityCreated: boolean;
  assignedAdvisorId: UUID | null;
  /** Razón por la que NO se creó opp nueva (si aplica). */
  skipReason?: "active_opportunity_exists" | "no_initial_stage";
}

export async function createLead(input: CreateLeadInput): Promise<CreateLeadResult> {
  const organizationId = getCurrentOrganizationId();
  // Funnel donde nace el lead (Fase 2). "outbound" cambia la etapa inicial,
  // el guard de opp activa, el funnel de la opp y marca el contacto outbound.
  const leadFunnel: Funnel = input.channel === "outbound" ? "outbound" : "venta";

  // 1. Validación de invariantes (nombre + teléfono obligatorios; el
  //    teléfono debe normalizar a E.164 — Whaapy lo exige). Los callers
  //    externos ya validan con Zod; este check es la última barrera del
  //    camino canónico.
  const fullName = input.fullName?.trim() ?? "";
  if (!fullName) throw new LeadValidationError("missing_name");
  const rawPhone = input.phone?.trim() ?? "";
  if (!rawPhone) throw new LeadValidationError("missing_phone");
  const normalizedPhone = normalizePhone(rawPhone, "MX");
  if (!normalizedPhone) throw new LeadValidationError("invalid_phone");
  const normalizedEmail = normalizeEmail(input.email ?? null);
  const addressJson: Json | null = input.address
    ? structuredAddressToJson(input.address)
    : null;
  // Mensaje del formulario de origen: vacío o solo-espacios cuenta como ausente.
  const leadMessage = input.message?.trim() || null;

  // 2. Resolver asesor (antes de tocar BD, para poder sellarlo en el contacto).
  let resolvedAdvisorId: UUID | null = null;
  let poolEmpty = false;
  if (input.assignment.mode === "explicit") {
    resolvedAdvisorId = input.assignment.advisorId ?? null;
    if (resolvedAdvisorId) {
      const vendors = await listActiveRealVendors(organizationId);
      if (!vendors.some((v) => v.id === resolvedAdvisorId)) {
        throw new LeadValidationError("advisor_not_eligible");
      }
    }
  } else {
    const pick = await pickRoundRobinAdvisor(organizationId);
    resolvedAdvisorId = pick.advisorId;
    poolEmpty = pick.poolSize === 0;
  }

  // 3. Dedup por identidad → enlazar a existente o crear contacto nuevo.
  const match = await matchLeadIdentity({
    phone: normalizedPhone,
    email: normalizedEmail,
  });
  const ts = new Date().toISOString();

  let contact: ContactRow;
  let contactCreated: boolean;
  if (match.recommendation === "link_existing" && match.match) {
    contact = match.match;
    contactCreated = false;
  } else {
    contact = await createContact({
      full_name: fullName,
      email: normalizedEmail,
      phone: normalizedPhone,
      address: addressJson,
      internal_note: null,
      shopify_state: null,
      shopify_tags: [],
      assigned_advisor_id: resolvedAdvisorId,
      shopify_customer_id: null,
      whaapy_contact_id: null,
      missing_phone: false,
      field_metadata: {} as Json,
      last_modified_at: ts,
      last_modified_source: "platform",
      deleted_in_shopify: false,
      deleted_in_whaapy: false,
      anonymized_at: null,
      last_whaapy_activity_at: null,
    });
    contactCreated = true;
  }

  // Asesor efectivo: NUNCA robar el asesor de un contacto que ya tiene
  // dueño (R2). Solo se setea el resuelto si el contacto no tenía asesor.
  const effectiveAdvisorId = contact.assigned_advisor_id ?? resolvedAdvisorId;
  if (
    !contactCreated &&
    contact.assigned_advisor_id === null &&
    effectiveAdvisorId !== null
  ) {
    contact = await updateContact(contact.id, {
      assigned_advisor_id: effectiveAdvisorId,
      last_modified_at: ts,
      last_modified_source: "platform",
    });
  }

  // 3.5 Canal Outbound: marcar el contacto como outbound y propagar a sus
  //     opps NO terminales ANTES de crear la opp, para que el birth-stamping
  //     de la opp nueva la lea true. Idempotente si ya estaba marcado (un
  //     contacto existente que el SDR vuelve a meter a Outbound).
  if (leadFunnel === "outbound") {
    contact = await setContactOutbound({
      contactId: contact.id,
      value: true,
      actorUserId: input.actorUserId ?? null,
    });
  }

  // 4. Oportunidad inicial — guard R12: respeta una opp activa existente en
  //    el MISMO funnel (un contacto puede tener opp de Venta y de Outbound).
  let opportunityId: UUID | null = null;
  let opportunityCreated = false;
  let skipReason: CreateLeadResult["skipReason"];

  const initialStage = await getInitialStage(leadFunnel);
  if (!initialStage) {
    skipReason = "no_initial_stage";
  } else {
    const activeOpps = await listOpportunities({
      funnel: leadFunnel,
      contactId: contact.id,
    });
    const blocking = activeOpps.find((opp) => isBlockingOpportunity(opp));
    if (blocking) {
      // Respeta dónde está: no se crea opp duplicada en este funnel.
      skipReason = "active_opportunity_exists";
    } else {
      const opp = await createOpportunity({
        funnel: leadFunnel,
        stage_id: initialStage.id,
        contact_id: contact.id,
        // Outbound nace SIN asignar: el SDR no es asesor y el vendedor se
        // elige en el handoff (Fase 3), aunque el contacto ya tuviera asesor.
        assigned_advisor_id: leadFunnel === "outbound" ? null : effectiveAdvisorId,
        // Marca outbound denormalizada del contacto (0040 — birth-stamping).
        is_outbound: contact.is_outbound,
        parent_opportunity_id: null,
        shopify_draft_order_id: null,
        shopify_order_id: null,
        display_reference: null,
        actual_amount: null,
        estimated_amount: null,
        currency: DEFAULT_CURRENCY,
        probability_override: null,
        weighted_amount: null,
        loss_reason_id: null,
        invoice_url: null,
        // El mensaje del formulario nace como nota de la opp: es el contexto
        // que el vendedor necesita al abrir la card.
        note: leadMessage,
        shipping_address: null,
        last_modified_at: ts,
        last_modified_source: "platform",
        won_at: null,
        lost_at: null,
        invoice_sent_at: null,
        cancelled_at: null,
        cancellation_source: null,
        cancellation_note: null,
        // Lead nacido en plataforma — su fecha real es created_at.
        shopify_created_at: null,
        // Atribución de origen (0038).
        lead_source: input.source,
        inbound_webhook_source_id: input.inboundWebhookSourceId ?? null,
      });
      await recordStageChange({
        opportunityId: opp.id,
        fromStageId: null,
        toStageId: initialStage.id,
        changedByUserId: input.actorUserId ?? null,
        context: input.source === "webhook" ? "webhook" : "manual",
      });
      opportunityId = opp.id;
      opportunityCreated = true;
    }
  }

  // 4.5 Mensaje del formulario → actividad en la historia. Se registra aunque
  //     NO se haya creado opp (contacto deduplicado con opp activa): sin esto
  //     el texto que escribió el lead se perdería justo en el caso en que el
  //     vendedor más lo necesita. Non-fatal: el lead ya está persistido.
  if (leadMessage) {
    try {
      await recordActivity({
        contactId: contact.id,
        opportunityId,
        activityType: "lead_message",
        description: leadMessage,
        payload: {
          source: input.source,
          inbound_webhook_source_id: input.inboundWebhookSourceId ?? null,
        } as Json,
        triggeredByUserId: input.actorUserId ?? null,
      });
    } catch {
      // no bloquear: el mensaje sigue en la nota de la opp.
    }
  }

  // 5. Audit `lead_created` SIEMPRE (fuente de atribución fiable incluso
  //    en el caso deduplicado-sin-opp-nueva).
  await recordAuditEvent({
    actorUserId: input.actorUserId ?? null,
    eventType: "lead_created",
    entityType: "contact",
    entityId: contact.id,
    payload: {
      source: input.source,
      inbound_webhook_source_id: input.inboundWebhookSourceId ?? null,
      assignment_mode: input.assignment.mode,
      assigned_advisor_id: effectiveAdvisorId,
      contact_created: contactCreated,
      contact_deduped: !contactCreated,
      opportunity_id: opportunityId,
      opportunity_created: opportunityCreated,
      skip_reason: skipReason ?? null,
    } as Json,
  });

  // 6. Pool round-robin vacío → alerta admin (nunca bloquea la creación).
  if (poolEmpty) {
    await notifyAdminsEmptyAdvisorPool(contact.id, input.source);
  }

  // 7. Propagación al Whaapy de Venta con el asesor (non-fatal). Reason:
  //    crear si el contacto aún no está en Whaapy; asignar (PATCH) si ya
  //    existe allá sin asignación. El asesor viaja vía snapshot; el worker
  //    resuelve whaapy_agent_id y adjunta assigned_agent_id (Track 2).
  try {
    const fresh = (await getContactById(contact.id)) ?? contact;
    if (fresh.phone && !fresh.missing_phone) {
      await recordWhaapySyncIntent(
        fresh,
        fresh.whaapy_contact_id
          ? "update_from_platform_ui"
          : "create_from_platform_ui",
      );
    }
  } catch (err) {
    // El lead ya está persistido; un fallo al ENCOLAR la propagación no
    // debe perder el lead. Se audita y se continúa (la sync a Whaapy se
    // puede reintentar). El path del webhook además reintenta el worker.
    await recordAuditEvent({
      actorUserId: null,
      eventType: "lead_whaapy_enqueue_failed",
      entityType: "contact",
      entityId: contact.id,
      payload: { error: (err as Error)?.message ?? String(err) } as Json,
    });
  }

  return {
    contactId: contact.id,
    opportunityId,
    contactCreated,
    opportunityCreated,
    assignedAdvisorId: effectiveAdvisorId,
    skipReason,
  };
}

async function notifyAdminsEmptyAdvisorPool(
  contactId: UUID,
  source: LeadSource,
): Promise<void> {
  const adminUserIds = await listOrgAdminUserIds();
  for (const userId of adminUserIds) {
    await createNotification({
      user_id: userId,
      notification_type: "lead_unassigned_no_advisors",
      origin: "system",
      origin_reference: { contact_id: contactId, source },
      opportunity_id: null,
      contact_id: contactId,
      title: "Lead sin asignar — no hay vendedores elegibles",
      message:
        "Entró un lead por reparto automático pero no hay vendedores activos para asignarlo. Quedó sin asesor. Revisa Admin · Usuarios.",
      amount_at_stake: null,
      due_at: null,
      status: "pending",
      snoozed_until: null,
      schema_version: "1",
      completed_at: null,
    });
  }
}
