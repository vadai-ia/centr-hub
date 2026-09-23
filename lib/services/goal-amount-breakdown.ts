import "server-only";
import { listPaidOrderDetailsInPeriod, type PaidOrderDetailRow } from "@/lib/db/goal-breakdown";
import { paidOrderInGoalScope, type GoalScope } from "@/lib/services/dashboard-metrics";
import {
  advancePercentFromTags,
  recognitionSlicesInPeriod,
} from "@/lib/services/revenue-recognition";
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
  /** Lo que cuenta para la meta EN ESTE MES (puede ser solo el anticipo). */
  subtotal: number;
  shipping: number;
  total: number;
  /** "anticipo 50%" / "liquidación 50%" cuando el pedido se reconoce partido. */
  note: string | null;
}

export interface AmountBreakdown {
  currency: string;
  rows: AmountBreakdownRow[];
  totals: Pick<AmountBreakdownRow, "products" | "discount" | "subtotal" | "shipping" | "total">;
}

/**
 * Arma el desglose con el MISMO reparto por anticipo que el KPI: de un pedido
 * etiquetado solo cuenta aquí la porción cuyo mes cae en el periodo, y la
 * columna del monto muestra esa porción (no el pedido completo). Sin eso, la
 * tabla del "¿de dónde sale esta cantidad?" no sumaría la barra.
 */
export function summarizeAmountBreakdown(
  orders: PaidOrderDetailRow[],
  period: { startUtc: string; endUtc: string },
): AmountBreakdown {
  const totals = { products: 0, discount: 0, subtotal: 0, shipping: 0, total: 0 };
  const rows: AmountBreakdownRow[] = [];
  for (const o of orders) {
    const full = Number(o.subtotal);
    const slices = recognitionSlicesInPeriod(o, period.startUtc, period.endUtc);
    if (slices.length === 0) continue;
    const subtotal = slices.reduce((s, x) => s + x.amount, 0);
    const pct = advancePercentFromTags(o.shopify_tags);
    const discount = Number(o.discount_amount);
    const note =
      pct === null || subtotal === full
        ? null
        : // Si la porción es el anticipo, su fecha es la del pedido.
          slices.some((s) => s.at === o.paid_at)
          ? `anticipo ${pct}%`
          : `liquidación ${100 - pct}%`;
    const row: AmountBreakdownRow = {
      orderName: o.shopify_name ?? "(sin folio)",
      paidAt: slices[0]?.at ?? o.paid_at,
      customer: o.contact?.full_name ?? o.contact?.email ?? o.contact?.phone ?? "(sin nombre)",
      // El subtotal de Shopify ya trae el descuento restado.
      products: subtotal + discount,
      discount,
      subtotal,
      shipping: Number(o.shipping_amount),
      total: Number(o.total_amount),
      note,
    };
    totals.products += row.products;
    totals.discount += row.discount;
    totals.subtotal += row.subtotal;
    totals.shipping += row.shipping;
    totals.total += row.total;
    rows.push(row);
  }
  return { currency: orders[0]?.currency ?? "MXN", rows, totals };
}

export async function loadGoalAmountBreakdown(
  monthKey: string,
  scope: GoalScope,
): Promise<AmountBreakdown | null> {
  const period = resolveMonthPeriod(monthKey);
  if (!period) return null;
  const orders = await listPaidOrderDetailsInPeriod(period.startUtc, period.endUtc);
  return summarizeAmountBreakdown(
    orders.filter((o) => paidOrderInGoalScope(o, scope)),
    period,
  );
}
