import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import {
  getLinkedOrderInfoByShopifyOrderIds,
  sumPaidOrdersForContact,
  type ContactOrderIndicators,
} from "@/lib/db/orders";
import { getContactById } from "@/lib/db/contacts";
import type {
  ContactRow,
  Funnel,
  ISODateString,
  Numeric,
  UUID,
} from "@/lib/types/database";

/**
 * Detalle consolidado de contacto para M6 (B3).
 *
 * Estrategia anti-N+1:
 *   - UNA query consolidada para opportunities (con stage embebido
 *     vía join PostgREST) en lugar de N queries por opp.
 *   - UNA query agregada para indicadores de órdenes
 *     (`sumPaidOrdersForContact`).
 *   - Contact row se obtiene aparte (caller usualmente ya lo tiene).
 *
 * El timeline NO se incluye aquí — vive en `lib/services/timeline.ts`
 * porque agrega múltiples fuentes y queremos separar la ortografía
 * "estado del contact" de "cronología de eventos".
 */

export interface ContactOpportunityListItem {
  id: UUID;
  funnel: Funnel;
  stage_id: UUID;
  stage_name: string;
  stage_color: string;
  stage_is_won: boolean;
  stage_is_lost: boolean;
  /** Folio del borrador (`#D1205`) — respaldo cuando aún no hay pedido. */
  display_reference: string | null;
  /** Folio del PEDIDO (`#1828`), resuelto desde `orders.shopify_name`. Es el
   *  que se muestra cuando existe: el del borrador es interno de Shopify. */
  order_reference: string | null;
  /** Origen del pedido enlazado (`orders.source`). `web` = compra online:
   *  entró sola por la tienda, sin vendedor. Derivado, no columna de la opp. */
  order_source: string | null;
  actual_amount: Numeric | null;
  estimated_amount: Numeric | null;
  currency: string;
  assigned_advisor_id: UUID | null;
  cancelled_at: ISODateString | null;
  won_at: ISODateString | null;
  invoice_url: string | null;
  last_modified_at: ISODateString;
  created_at: ISODateString;
}

export interface ContactDetail {
  contact: ContactRow;
  /** Derivación O12 (lead/cliente) — coincide con la columna STORED. */
  contactType: "lead" | "cliente";
  indicators: ContactOrderIndicators;
  opportunities: {
    venta: ContactOpportunityListItem[];
    postVenta: ContactOpportunityListItem[];
  };
}

/**
 * Trae el detalle consolidado del contacto. Retorna null si no existe
 * en la org activa (RLS-equivalente vía .eq("organization_id", ...)).
 *
 * La lista de oportunidades incluye CANCELADAS para que la UI pueda
 * mostrar histórico completo del contacto. La lista las trae todas y
 * la UI decide cómo separarlas (typical: activas/perdidas/ganadas en
 * la sección principal, canceladas plegadas en sub-vista).
 */
export async function getContactDetail(
  contactId: UUID,
): Promise<ContactDetail | null> {
  const contact = await getContactById(contactId);
  if (!contact) return null;

  const [oppRows, indicators] = await Promise.all([
    fetchContactOpportunitiesWithStage(contactId),
    sumPaidOrdersForContact(contactId),
  ]);

  const venta: ContactOpportunityListItem[] = [];
  const postVenta: ContactOpportunityListItem[] = [];
  for (const opp of oppRows) {
    if (opp.funnel === "venta") venta.push(opp);
    else postVenta.push(opp);
  }

  return {
    contact,
    contactType: contact.shopify_customer_id ? "cliente" : "lead",
    indicators,
    opportunities: { venta, postVenta },
  };
}

interface OpportunityWithStageJoined {
  id: UUID;
  funnel: Funnel;
  stage_id: UUID;
  display_reference: string | null;
  shopify_order_id: string | null;
  actual_amount: Numeric | null;
  estimated_amount: Numeric | null;
  currency: string;
  assigned_advisor_id: UUID | null;
  cancelled_at: ISODateString | null;
  won_at: ISODateString | null;
  invoice_url: string | null;
  last_modified_at: ISODateString;
  created_at: ISODateString;
  stage: {
    name: string;
    color: string;
    is_won: boolean;
    is_lost: boolean;
  } | null;
}

async function fetchContactOpportunitiesWithStage(
  contactId: UUID,
): Promise<ContactOpportunityListItem[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select(
      "id, funnel, stage_id, display_reference, shopify_order_id, actual_amount, " +
      "estimated_amount, currency, assigned_advisor_id, cancelled_at, " +
      "won_at, invoice_url, last_modified_at, created_at, " +
      "stage:pipeline_stages!inner(name, color, is_won, is_lost)",
    )
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .order("last_modified_at", { ascending: false });
  if (error) throw error;

  const rows = (data ?? []) as unknown as OpportunityWithStageJoined[];
  // Folio del pedido en lote: la lista del contacto muestra el mismo número
  // que el kanban y la búsqueda, no el del borrador.
  const linkedOrders = await getLinkedOrderInfoByShopifyOrderIds(
    rows.map((r) => r.shopify_order_id).filter((id): id is string => !!id),
  );
  return rows.map((r) => ({
    id: r.id,
    funnel: r.funnel,
    stage_id: r.stage_id,
    stage_name: r.stage?.name ?? "Etapa desconocida",
    stage_color: r.stage?.color ?? "#94A3B8",
    stage_is_won: r.stage?.is_won ?? false,
    stage_is_lost: r.stage?.is_lost ?? false,
    display_reference: r.display_reference,
    order_reference: r.shopify_order_id
      ? linkedOrders.get(r.shopify_order_id)?.name ?? null
      : null,
    order_source: r.shopify_order_id
      ? linkedOrders.get(r.shopify_order_id)?.source ?? null
      : null,
    actual_amount: r.actual_amount,
    estimated_amount: r.estimated_amount,
    currency: r.currency,
    assigned_advisor_id: r.assigned_advisor_id,
    cancelled_at: r.cancelled_at,
    won_at: r.won_at,
    invoice_url: r.invoice_url,
    last_modified_at: r.last_modified_at,
    created_at: r.created_at,
  }));
}
