import type { ReopenSearchRow } from "@/lib/db/opportunities";
import type { ReopenSearchResultItem } from "@/lib/types/pipeline";

/**
 * Lógica pura de presentación para la búsqueda de reapertura (M4v2).
 * Vive fuera de la action ("use server" solo exporta funciones async) y
 * es testeable en aislamiento.
 */

export function deriveReopenStatusLabel(row: ReopenSearchRow): string {
  if (row.cancelled_at) return "Cancelada";
  if (row.resolved_at) return "Resuelto";
  if (row.won_at) return row.funnel === "venta" ? "Ganada" : "Caso cerrado";
  if (row.lost_at) return "Perdida";
  return "Activa";
}

export function reopenRowToItem(r: ReopenSearchRow): ReopenSearchResultItem {
  return {
    id: r.id,
    funnel: r.funnel,
    stageName: r.stage_name,
    contactName:
      r.contact?.full_name?.trim() || r.contact?.phone?.trim() || "Sin nombre",
    reference: r.display_reference ?? r.shopify_order_id ?? null,
    statusLabel: deriveReopenStatusLabel(r),
    lastModifiedAt: r.last_modified_at,
  };
}

/**
 * Colapsa las opps de un MISMO caso real en una sola entrada: la Venta
 * Ganada y su hija Post-venta comparten contacto + pedido
 * (`display_reference`/`shopify_order_id`, heredados por el trigger
 * F1→F2) y, por el servicio híbrido, reabren al mismo destino — mostrar
 * ambas es ruido. Se agrupa por `contact_id + clave de pedido`; las opps
 * SIN pedido (deals distintos en curso) quedan como entradas propias.
 * Representante: se prefiere la entidad Post-venta (destino real de la
 * reapertura, donde viven los problemas); si no hay, la más reciente.
 * Solo presentación — el servicio de reapertura no cambia.
 *
 * Espera `rows` ordenadas por `last_modified_at` desc (como las entrega
 * el data layer): así el "primero visto" de cada grupo es el más reciente.
 */
export function collapseReopenResults(
  rows: ReopenSearchRow[],
): ReopenSearchResultItem[] {
  const groups = new Map<string, ReopenSearchRow>();
  for (const r of rows) {
    const orderKey =
      r.display_reference?.trim() || r.shopify_order_id?.trim() || null;
    const key = orderKey ? `${r.contact_id}::${orderKey}` : `id::${r.id}`;
    const current = groups.get(key);
    if (!current) {
      groups.set(key, r);
      continue;
    }
    // Reemplaza solo para preferir Post-venta sobre Venta; en cualquier
    // otro caso conserva el primero visto (= el más reciente del grupo).
    if (r.funnel === "post_venta" && current.funnel !== "post_venta") {
      groups.set(key, r);
    }
  }
  return Array.from(groups.values())
    .map(reopenRowToItem)
    .sort((a, b) => (a.lastModifiedAt < b.lastModifiedAt ? 1 : -1));
}
