import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { getOpportunityById, listLineItems } from "@/lib/db/opportunities";
import type {
  ContactRow,
  ISODateString,
  LossReasonRow,
  Numeric,
  OpportunityLineItemRow,
  OpportunityRow,
  PipelineStageRow,
  UUID,
} from "@/lib/types/database";

/**
 * Detalle consolidado de oportunidad para el popup M6 (B4).
 *
 * Estrategia: una query principal con joins PostgREST (stage,
 * contact resumido, loss_reason) + una query separada para line
 * items (vienen como lista, no encajan en el shape primario sin
 * inflar el payload por join cartesiano).
 *
 * El timeline de la oportunidad vive en `lib/services/timeline.ts`.
 *
 * Para "oportunidad perdida": `loss_reason` (objeto completo) + el
 * campo `opportunity.note` (donde el move-service de M5 persiste la
 * nota libre que el asesor capturó en el modal de pérdida). La UI
 * combina ambos: "Perdida por <reason.name>: <opportunity.note>".
 */

export interface OpportunityContactSummary {
  id: UUID;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  shopify_customer_id: string | null;
  whaapy_contact_id: string | null;
  contactType: "lead" | "cliente";
  missing_phone: boolean;
  assigned_advisor_id: UUID | null;
}

export interface OpportunityDetail {
  opportunity: OpportunityRow;
  stage: PipelineStageRow;
  contact: OpportunityContactSummary;
  lineItems: OpportunityLineItemRow[];
  lossReason: LossReasonRow | null;
}

/**
 * Trae el detalle consolidado. Devuelve null si no existe en la org
 * activa o si la opp fue borrada (no cancelada — cancelada se devuelve
 * con `cancelled_at` poblado para que la UI muestre el indicador).
 */
export async function getOpportunityDetail(
  opportunityId: UUID,
): Promise<OpportunityDetail | null> {
  const opportunity = await getOpportunityById(opportunityId);
  if (!opportunity) return null;

  const [joined, lineItems] = await Promise.all([
    fetchOpportunityJoinedShape(opportunityId),
    listLineItems(opportunityId),
  ]);

  if (!joined) return null;

  return {
    opportunity,
    stage: joined.stage,
    contact: joined.contact,
    lineItems,
    lossReason: joined.lossReason,
  };
}

interface JoinedShape {
  stage: PipelineStageRow;
  contact: OpportunityContactSummary;
  lossReason: LossReasonRow | null;
}

interface RawJoinedRow {
  stage: PipelineStageRow | null;
  contact: (Pick<
    ContactRow,
    | "id"
    | "full_name"
    | "email"
    | "phone"
    | "shopify_customer_id"
    | "whaapy_contact_id"
    | "missing_phone"
    | "assigned_advisor_id"
  > & { __extra?: never }) | null;
  loss_reason: LossReasonRow | null;
}

async function fetchOpportunityJoinedShape(
  opportunityId: UUID,
): Promise<JoinedShape | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select(
      "stage:pipeline_stages!inner(*), " +
      "contact:contacts!inner(id, full_name, email, phone, shopify_customer_id, whaapy_contact_id, missing_phone, assigned_advisor_id), " +
      "loss_reason:loss_reasons(*)",
    )
    .eq("id", opportunityId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as unknown as RawJoinedRow;
  if (!row.stage || !row.contact) return null;

  const contact: OpportunityContactSummary = {
    id: row.contact.id,
    full_name: row.contact.full_name,
    email: row.contact.email,
    phone: row.contact.phone,
    shopify_customer_id: row.contact.shopify_customer_id,
    whaapy_contact_id: row.contact.whaapy_contact_id,
    contactType: row.contact.shopify_customer_id ? "cliente" : "lead",
    missing_phone: row.contact.missing_phone,
    assigned_advisor_id: row.contact.assigned_advisor_id,
  };

  return {
    stage: row.stage,
    contact,
    lossReason: row.loss_reason ?? null,
  };
}

/**
 * Re-exports de helpers de display (viven en `lib/format/money` para
 * que Client Components puedan importarlos sin chocar con `server-only`).
 */
export { effectiveAmount, formatAmount } from "@/lib/format/money";

export type { ISODateString };
