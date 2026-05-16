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
