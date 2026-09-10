import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import type {
  OrderLineItemRow,
  OrderRow,
  Database,
  UUID,
} from "@/lib/types/database";

type Insert = Database["public"]["Tables"]["orders"]["Insert"];
type Update = Database["public"]["Tables"]["orders"]["Update"];
type LineInsert = Database["public"]["Tables"]["order_line_items"]["Insert"];

export async function getOrderById(id: UUID): Promise<OrderRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function findOrderByShopifyOrderId(
  shopifyOrderId: string,
): Promise<OrderRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("shopify_order_id", shopifyOrderId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function createOrder(
  input: Omit<Insert, "organization_id">,
): Promise<OrderRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("orders")
    .insert({ ...input, organization_id: organizationId })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function updateOrder(id: UUID, patch: Update): Promise<OrderRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("orders")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function listOrderLineItems(orderId: UUID): Promise<OrderLineItemRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("order_line_items")
    .select("*")
    .eq("order_id", orderId)
    .eq("organization_id", organizationId);
  if (error) throw error;
  return data ?? [];
}

export async function replaceOrderLineItems(
  orderId: UUID,
  items: Array<Omit<LineInsert, "organization_id" | "order_id">>,
): Promise<OrderLineItemRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { error: delError } = await supabase
    .from("order_line_items")
    .delete()
    .eq("order_id", orderId)
    .eq("organization_id", organizationId);
  if (delError) throw delError;
  if (items.length === 0) return [];
  const toInsert = items.map((it) => ({
    ...it,
    organization_id: organizationId,
    order_id: orderId,
  }));
  const { data, error } = await supabase
    .from("order_line_items")
    .insert(toInsert)
    .select("*");
  if (error) throw error;
  return data ?? [];
}

/**
 * Órdenes sin `shopify_created_at` poblado (migración 0024). Usado por
 * el correctivo `backfill-order-shopify-created-at` para enumerar qué
 * filas necesitan que se les traiga la fecha real de Shopify. Devuelve
 * el subconjunto de columnas que el correctivo necesita para reportar
 * (incluye `opportunity_id` para distinguir las huérfanas O6).
 *
 * Idempotente por construcción: una vez poblado el campo, la fila deja
 * de aparecer aquí, así que re-correr el correctivo no la reprocesa.
 */
export interface OrderMissingShopifyCreatedAt {
  id: UUID;
  shopify_order_id: string;
  opportunity_id: UUID | null;
  created_at: string;
}

export async function listOrdersMissingShopifyCreatedAt(): Promise<
  OrderMissingShopifyCreatedAt[]
> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("orders")
    .select("id, shopify_order_id, opportunity_id, created_at")
    .eq("organization_id", organizationId)
    .is("shopify_created_at", null)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as OrderMissingShopifyCreatedAt[];
}

/**
 * Suma de revenue real para el periodo. R5: solo órdenes con
 * financial_status = 'paid' cuentan; usa total_amount y paid_at.
 */
export async function sumPaidRevenueBetween(
  periodStart: string,
  periodEnd: string,
): Promise<number> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("orders")
    .select("total_amount")
    .eq("organization_id", organizationId)
    .eq("financial_status", "paid")
    .gte("paid_at", periodStart)
    .lte("paid_at", periodEnd);
  if (error) throw error;
  return (data ?? []).reduce((acc, row) => acc + Number(row.total_amount), 0);
}

/**
 * Indicadores históricos del contacto para M6: cantidad de órdenes
 * ganadas (pagadas y no canceladas) y suma de revenue. La moneda se
 * deja al caller — Centr opera con MXN (default org), pero si una
 * orden histórica fue en otra divisa, el agregado puro pierde la
 * dimensión. Aceptable para indicadores de "monto total con este
 * cliente" en MVP donde todos los datos son MXN.
 *
 * R5: cancelado ≠ perdido — `cancelled_at IS NULL` excluye órdenes
 * que Shopify revocó administrativamente.
 */
export interface ContactOrderIndicators {
  paidOrdersCount: number;
  paidRevenueTotal: number;
  currency: string;
}

export async function sumPaidOrdersForContact(
  contactId: UUID,
): Promise<ContactOrderIndicators> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("orders")
    .select("total_amount, currency")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("financial_status", "paid")
    .is("cancelled_at", null);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ total_amount: string; currency: string }>;
  let total = 0;
  let currency = "MXN";
  for (const row of rows) {
    total += Number(row.total_amount);
    if (row.currency) currency = row.currency;
  }
  return {
    paidOrdersCount: rows.length,
    paidRevenueTotal: total,
    currency,
  };
}

/**
 * Lista órdenes de un contacto ordenadas por `paid_at DESC` (con
 * fallback `created_at`). Usada por el timeline del detalle de
 * contacto (M6) para emitir eventos `order_paid` / `order_cancelled`.
 *
 * Default excluye nada — el caller decide qué financial_status mostrar.
 * Para "órdenes ganadas" del header de indicadores, usar
 * `sumPaidOrdersForContact` que filtra paid + not-cancelled.
 */
export async function listOrdersForContact(
  contactId: UUID,
  limit = 100,
): Promise<OrderRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

/**
 * Mapa `shopify_order_id` → folio del pedido (`orders.shopify_name`, `#1828`).
 *
 * Lo usa la capa de lectura de oportunidades para enseñar el número que el
 * cliente reconoce en vez del folio del borrador que guarda la opp
 * (`display_reference`, `#D1205`). Se resuelve en lote: una consulta por
 * página de cards, no una por card.
 *
 * Chunked: `in.()` con miles de ids revienta el largo de la URL de PostgREST.
 * Los ids sin pedido en la base simplemente no aparecen en el mapa y el
 * caller cae al folio del borrador.
 */
export async function getOrderNamesByShopifyOrderIds(
  shopifyOrderIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = Array.from(
    new Set(shopifyOrderIds.map((id) => id?.trim()).filter((id): id is string => !!id)),
  );
  if (ids.length === 0) return out;

  const { supabase, organizationId } = getTenantScopedClient();
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("orders")
      .select("shopify_order_id, shopify_name")
      .eq("organization_id", organizationId)
      .in("shopify_order_id", chunk);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{
      shopify_order_id: string | null;
      shopify_name: string | null;
    }>) {
      const id = row.shopify_order_id?.trim();
      const name = row.shopify_name?.trim();
      if (id && name) out.set(id, name);
    }
  }
  return out;
}

/**
 * `shopify_order_id`s cuyos pedidos matchean el texto buscado por folio
 * (`shopify_name` ilike). Espeja `searchContactIdsForQuery`: se pre-resuelven
 * los ids y el caller los inyecta como `shopify_order_id.in.(...)` en su
 * `.or()`, porque PostgREST no permite mezclar un predicado sobre una tabla
 * embebida con los de la tabla padre.
 *
 * Sin esto, buscar "1828" (el número que el cliente y Post-venta conocen) no
 * encuentra nada: la opp solo guarda el folio del borrador.
 */
export async function searchShopifyOrderIdsForQuery(
  rawQuery: string,
): Promise<string[]> {
  const sanitized = rawQuery
    .trim()
    .replace(/[,.()*%\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (sanitized.length === 0) return [];

  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("orders")
    .select("shopify_order_id")
    .eq("organization_id", organizationId)
    .ilike("shopify_name", `%${sanitized}%`)
    .limit(5000);
  if (error) throw error;
  return (data ?? [])
    .map((r) => (r as { shopify_order_id: string | null }).shopify_order_id?.trim())
    .filter((id): id is string => !!id);
}
