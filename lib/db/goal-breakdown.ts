import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { fetchAllPaged } from "@/lib/db/paginate";
import type { UUID } from "@/lib/types/database";

/**
 * Detalle de los pedidos pagados de un periodo, para el desglose "Ver pedidos"
 * de la meta de monto (Admin → Metas).
 *
 * Mismas dos ventanas que `listRevenueOrdersInPeriod` (lib/db/dashboard.ts) —
 * `paid_at` o `settled_at` dentro del periodo, sin cancelados — para que la
 * tabla sume exactamente lo que marca la barra. El servicio aplica encima el
 * MISMO reparto por anticipo (`recognitionSlices`). Si allá cambia el
 * criterio, acá tiene que cambiar igual.
 *
 * Vive aparte de dashboard.ts a propósito: trae el total del pedido como DATO
 * a mostrar, y ese módulo tiene prohibido leerlo (la venta se mide por
 * subtotal — tests/amount-subtotal-contract.test.ts).
 */
export interface PaidOrderDetailRow {
  id: UUID;
  shopify_name: string | null;
  paid_at: string | null;
  /** Cuándo se liquidó (0055): mes en el que cae la segunda mitad. */
  settled_at: string | null;
  financial_status: string;
  cancelled_at: string | null;
  shopify_tags: string[] | null;
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
  const columns =
    "id, shopify_name, paid_at, settled_at, financial_status, cancelled_at, shopify_tags, " +
    "subtotal, discount_amount, shipping_amount, total_amount, currency, " +
    "assigned_advisor_id, is_outbound, source, contact:contacts(full_name, email, phone)";
  const base = () =>
    supabase
      .from("orders")
      .select(columns)
      .eq("organization_id", organizationId)
      // Cancelado no es venta: el detalle exportado debe cuadrar con el KPI.
      .is("cancelled_at", null);

  const [byProcessed, bySettled] = await Promise.all([
    fetchAllPaged<PaidOrderDetailRow>(() =>
      base().gte("paid_at", startUtc).lte("paid_at", endUtc),
    ),
    fetchAllPaged<PaidOrderDetailRow>(() =>
      base().gte("settled_at", startUtc).lte("settled_at", endUtc),
    ),
  ]);

  const byId = new Map<string, PaidOrderDetailRow>();
  for (const row of [...byProcessed, ...bySettled]) byId.set(row.id, row);
  return Array.from(byId.values()).sort((a, b) =>
    (a.paid_at ?? "").localeCompare(b.paid_at ?? ""),
  );
}
