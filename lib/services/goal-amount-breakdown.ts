import "server-only";
import { listPaidOrderDetailsInPeriod, type PaidOrderDetailRow } from "@/lib/db/goal-breakdown";
import { paidOrderInGoalScope, type GoalScope } from "@/lib/services/dashboard-metrics";
import { resolveMonthPeriod } from "@/lib/time/period";

/**
 * Desglose de la meta de monto: los pedidos pagados que suman el avance de un
 * sujeto (equipo, venta orgánica o un vendedor) en un mes. Responde "¿de dónde
 * sale esta cantidad?".
 *
 * Se recalcula de los pedidos, no del snapshot: en un mes cerrado la barra
 * muestra lo congelado al cierre y puede no coincidir si el criterio cambió
 * después (la pantalla lo advierte).
 */

export interface AmountBreakdownRow {
  orderName: string;
  paidAt: string | null;
  customer: string;
  /** Productos a precio de lista = subtotal + descuento. */
  products: number;
  discount: number;
  /** Lo que cuenta para la meta. */
  subtotal: number;
  shipping: number;
  total: number;
}

export interface AmountBreakdown {
  currency: string;
  rows: AmountBreakdownRow[];
  totals: Pick<AmountBreakdownRow, "products" | "discount" | "subtotal" | "shipping" | "total">;
}

export function summarizeAmountBreakdown(orders: PaidOrderDetailRow[]): AmountBreakdown {
  const totals = { products: 0, discount: 0, subtotal: 0, shipping: 0, total: 0 };
  const rows = orders.map((o) => {
    const subtotal = Number(o.subtotal);
    const discount = Number(o.discount_amount);
    const row: AmountBreakdownRow = {
      orderName: o.shopify_name ?? "(sin folio)",
      paidAt: o.paid_at,
      customer: o.contact?.full_name ?? o.contact?.email ?? o.contact?.phone ?? "(sin nombre)",
      // El subtotal de Shopify ya trae el descuento restado.
      products: subtotal + discount,
      discount,
      subtotal,
      shipping: Number(o.shipping_amount),
      total: Number(o.total_amount),
    };
    totals.products += row.products;
    totals.discount += row.discount;
    totals.subtotal += row.subtotal;
    totals.shipping += row.shipping;
    totals.total += row.total;
    return row;
  });
  return { currency: orders[0]?.currency ?? "MXN", rows, totals };
}

export async function loadGoalAmountBreakdown(
  monthKey: string,
  scope: GoalScope,
): Promise<AmountBreakdown | null> {
  const period = resolveMonthPeriod(monthKey);
  if (!period) return null;
  const orders = await listPaidOrderDetailsInPeriod(period.startUtc, period.endUtc);
  return summarizeAmountBreakdown(orders.filter((o) => paidOrderInGoalScope(o, scope)));
}
