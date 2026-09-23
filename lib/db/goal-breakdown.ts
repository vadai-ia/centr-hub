import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { fetchAllPaged } from "@/lib/db/paginate";
import type { UUID } from "@/lib/types/database";

/**
 * Detalle de los pedidos pagados de un periodo, para el desglose "Ver pedidos"
 * de la meta de monto (Admin → Metas).
 *
 * Mismos filtros que `listPaidOrdersInPeriod` (lib/db/dashboard.ts) — pagados,
 * por `paid_at` — para que la tabla sume exactamente lo que marca la barra.
 * Si ese filtro cambia, este tiene que cambiar igual.
 *
 * Vive aparte de dashboard.ts a propósito: trae el total del pedido como DATO
 * a mostrar, y ese módulo tiene prohibido leerlo (la venta se mide por
 * subtotal — tests/amount-subtotal-contract.test.ts).
 */
export interface PaidOrderDetailRow {
  shopify_name: string | null;
  paid_at: string | null;
  subtotal: string;
  discount_amount: string;
  shipping_amount: string;
  total_amount: string;
  currency: string;
  assigned_advisor_id: UUID | null;
  is_outbound: boolean;
  source: string | null;
  contact: { full_name: string | null; email: string | null; phone: string | null } | null;
}

export async function listPaidOrderDetailsInPeriod(
  startUtc: string,
  endUtc: string,
): Promise<PaidOrderDetailRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  return fetchAllPaged<PaidOrderDetailRow>(() =>
    supabase
      .from("orders")
      .select(
        "shopify_name, paid_at, subtotal, discount_amount, shipping_amount, total_amount, currency, " +
          "assigned_advisor_id, is_outbound, source, contact:contacts(full_name, email, phone)",
      )
      .eq("organization_id", organizationId)
      .eq("financial_status", "paid")
      // Cancelado no es venta: el detalle exportado debe cuadrar con el KPI.
      .is("cancelled_at", null)
      .gte("paid_at", startUtc)
      .lte("paid_at", endUtc)
      .order("paid_at", { ascending: true }),
  );
}
