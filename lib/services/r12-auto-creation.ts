import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { getOrganizationById } from "@/lib/db/organizations";
import { getInitialStage } from "@/lib/db/pipeline";
import {
  createOpportunity,
  listOpportunities,
  recordStageChange,
} from "@/lib/db/opportunities";
import { recordAuditEvent } from "@/lib/db/operational";
import { DEFAULT_CURRENCY } from "@/lib/constants";
import type { ContactRow, Json, OpportunityRow, UUID } from "@/lib/types/database";

/**
 * Auto-creación C2 (R12 — doctrina v5.1).
 *
 * Dos disparadores generan oportunidad nueva en la etapa con
 * `is_initial = true` del Funnel Venta ("Lead nuevo" en el catálogo
 * pre-cargado):
 *   - "new_contact_in_whaapy": contacto nuevo entra a Whaapy.
 *   - "reactivity_after_n_days": contacto registra actividad después
 *     de N días sin movimiento (N = `organizations.c2_reactivity_threshold_days`,
 *     default 30).
 *
 * Pre-condiciones (TODAS deben cumplirse):
 *   - `organizations.backfill_in_progress = false`.
 *   - El Funnel Venta tiene etapa con `is_initial = true`.
 *   - El contacto NO tiene oportunidad activa (no terminal —
 *     no ganada, no perdida, cancelled_at IS NULL) en Funnel Venta.
 *
 * Asesor: heredado del `assigned_advisor_id` del contact. Si el
 * contact no tiene asesor, la oportunidad queda sin asignar.
 *
 * Audit obligatorio: `c2_opportunity_auto_created` con `trigger`,
 * `contact_id`, `opportunity_id`, `assigned_advisor_id`,
 * `triggered_by_event`. Si NO se crea, registramos `c2_evaluation_skipped`
 * con la razón — trazabilidad operativa.
 */

export type R12Trigger =
  | "new_contact_in_whaapy"
  | "reactivity_after_n_days";

export type R12SourceEvent = "contact.created" | "conversation.created";

export type R12SkipReason =
  | "backfill_in_progress"
  | "no_initial_stage"
  | "active_opportunity_exists"
  | "reactivity_threshold_not_met"
  | "organization_not_found";

export interface EvaluateR12Input {
  contact: ContactRow;
  trigger: R12Trigger;
  triggeredByEvent: R12SourceEvent;
  /** Última actividad PREVIA a este webhook (NULL si nunca). */
  previousActivityAt: string | null;
  /** Timestamp del evento actual (para evaluar el delta de reactividad). */
  currentActivityAt: string;
}

export interface EvaluateR12Result {
  created: boolean;
  opportunityId?: UUID;
  skipReason?: R12SkipReason;
}

export async function evaluateAndCreateC2Opportunity(
  input: EvaluateR12Input,
): Promise<EvaluateR12Result> {
  const { organizationId } = getTenantScopedClient();
  const org = await getOrganizationById(organizationId);
  if (!org) {
    return await skip("organization_not_found", input);
  }

  const backfill =
    (org as unknown as { backfill_in_progress?: boolean }).backfill_in_progress;
  if (backfill === true) {
    return await skip("backfill_in_progress", input);
  }

  // Para reactividad: validar threshold antes de gastar lookups.
  if (input.trigger === "reactivity_after_n_days") {
    const thresholdDays =
      (org as unknown as { c2_reactivity_threshold_days?: number })
        .c2_reactivity_threshold_days ?? 30;
    if (!hasReactivityElapsed(input.previousActivityAt, input.currentActivityAt, thresholdDays)) {
      return await skip("reactivity_threshold_not_met", input);
    }
  }

  // Pre-condición: etapa inicial del Funnel Venta debe existir.
  const initialStage = await getInitialStage("venta");
  if (!initialStage) {
    return await skip("no_initial_stage", input);
  }

  // Pre-condición: contact NO debe tener oportunidad activa no-terminal en Funnel Venta.
  const activeOpps = await listOpportunities({
    funnel: "venta",
    contactId: input.contact.id,
  });
  const blocking = activeOpps.find((opp) => isBlockingOpportunity(opp));
  if (blocking) {
    return await skip("active_opportunity_exists", input);
  }

  // Crear oportunidad.
  const ts = new Date().toISOString();
  const opp = await createOpportunity({
    funnel: "venta",
    stage_id: initialStage.id,
    contact_id: input.contact.id,
    assigned_advisor_id: input.contact.assigned_advisor_id ?? null,
    // Marca outbound denormalizada del contacto (0040 — birth-stamping).
    is_outbound: input.contact.is_outbound,
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
    note: null,
    shipping_address: null,
    last_modified_at: ts,
    last_modified_source: "platform",
    won_at: null,
    lost_at: null,
    invoice_sent_at: null,
    cancelled_at: null,
    cancellation_source: null,
    cancellation_note: null,
    // Lead nacido en plataforma (R12) — sin Draft Order de Shopify. Su
    // fecha real es created_at (la generada effective_created_at cae a
    // él). No hay fecha de Shopify que forzar (migración 0025).
    shopify_created_at: null,
  });

  await recordStageChange({
    opportunityId: opp.id,
    fromStageId: null,
    toStageId: initialStage.id,
    changedByUserId: null,
    // Entrada a "Lead nuevo" nacida en plataforma → su fecha real es
    // changed_at; no se pasa shopifyEventAt (migración 0025).
    context: "automation",
  });

  await recordAuditEvent({
    actorUserId: null,
    eventType: "c2_opportunity_auto_created",
    entityType: "opportunity",
    entityId: opp.id,
    payload: {
      trigger: input.trigger,
      contact_id: input.contact.id,
      opportunity_id: opp.id,
      assigned_advisor_id: input.contact.assigned_advisor_id ?? null,
      triggered_by_event: input.triggeredByEvent,
    } as Json,
  });

  return { created: true, opportunityId: opp.id };
}

function hasReactivityElapsed(
  previous: string | null,
  current: string,
  thresholdDays: number,
): boolean {
  // Nunca tuvo actividad previa: no es "reactividad" — el disparador
  // correcto es `new_contact_in_whaapy`. Aún así, conservador: no
  // crear oportunidad por este path.
  if (!previous) return false;
  const prev = new Date(previous).getTime();
  const now = new Date(current).getTime();
  const diffDays = (now - prev) / (1000 * 60 * 60 * 24);
  return diffDays >= thresholdDays;
}

/**
 * Guard compartido "el contacto ya tiene un ciclo abierto en Funnel Venta".
 * Reutilizado por R12 (auto-creación C2) y por el camino canónico de
 * creación de leads (`createLead`) — misma semántica para "respetar la
 * oportunidad/etapa existente en vez de crear un Lead nuevo duplicado".
 *
 * Bloquea cualquier opp con `cancelled_at IS NULL` (listOpportunities ya
 * filtra por default, pero defensivo). Bloquea también las opps ya en
 * etapa won/lost: si un contacto ya cerró un ciclo previo en Funnel Venta,
 * el ciclo nuevo lo dispara la lógica explícita del vendedor, no la
 * auto/lead-creación.
 */
export function isBlockingOpportunity(opp: OpportunityRow): boolean {
  return opp.cancelled_at === null;
}

async function skip(
  reason: R12SkipReason,
  input: EvaluateR12Input,
): Promise<EvaluateR12Result> {
  await recordAuditEvent({
    actorUserId: null,
    eventType: "c2_evaluation_skipped",
    entityType: "contact",
    entityId: input.contact.id,
    payload: {
      reason,
      trigger: input.trigger,
      triggered_by_event: input.triggeredByEvent,
    } as Json,
  });
  return { created: false, skipReason: reason };
}
