import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import type { UUID } from "@/lib/types/database";

/**
 * Agregación y re-atribución de tags Shopify (M7.2, Bloque 5).
 *
 * Las tags viven en `contacts.shopify_tags` y `orders.shopify_tags`
 * (text[] con el casing original de Shopify). La normalización
 * (trim + lowercase) es la misma que usa el parser de tags
 * (`lib/services/tag-parser.ts`). El conteo de "entidades que la
 * llevan" suma contactos + órdenes distintos por tag normalizada.
 */

const SCAN_LIMIT = 50000;

function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase();
}

export interface DetectedTagAggregate {
  normalized: string;
  /** Representante con casing original (primera aparición). */
  original: string;
  /** Conteo de entidades (contactos + órdenes) que llevan la tag. */
  count: number;
}

export async function aggregateDetectedTags(): Promise<DetectedTagAggregate[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const agg = new Map<string, { original: string; count: number }>();

  for (const table of ["contacts", "orders"] as const) {
    const { data, error } = await supabase
      .from(table)
      .select("shopify_tags")
      .eq("organization_id", organizationId)
      .limit(SCAN_LIMIT);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ shopify_tags: string[] | null }>) {
      const tags = row.shopify_tags ?? [];
      const seen = new Set<string>();
      for (const raw of tags) {
        const norm = normalizeTag(raw);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        const cur = agg.get(norm);
        if (cur) cur.count += 1;
        else agg.set(norm, { original: raw.trim(), count: 1 });
      }
    }
  }

  return Array.from(agg.entries()).map(([normalized, v]) => ({
    normalized,
    original: v.original,
    count: v.count,
  }));
}

/**
 * Órdenes cuya `shopify_tags` contiene la tag (match case-insensitive
 * por normalización). Devuelve id + opportunity_id para cascada.
 */
export async function findOrdersWithTag(
  normalizedTag: string,
): Promise<Array<{ id: UUID; opportunity_id: UUID | null }>> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("orders")
    .select("id, opportunity_id, shopify_tags")
    .eq("organization_id", organizationId)
    .limit(SCAN_LIMIT);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: UUID;
    opportunity_id: UUID | null;
    shopify_tags: string[] | null;
  }>;
  return rows
    .filter((r) => (r.shopify_tags ?? []).some((t) => normalizeTag(t) === normalizedTag))
    .map((r) => ({ id: r.id, opportunity_id: r.opportunity_id }));
}

/**
 * Re-atribuye una lista de órdenes (y sus oportunidades ligadas) a un
 * asesor. `membershipId = null` no se usa hoy (el re-proceso solo se
 * dispara al mapear a vendor), pero se admite para futura simetría.
 * Devuelve el conteo de entidades efectivamente actualizadas.
 */
export async function reattributeOrders(
  orders: Array<{ id: UUID; opportunity_id: UUID | null }>,
  membershipId: UUID | null,
): Promise<number> {
  const { supabase, organizationId } = getTenantScopedClient();
  let updated = 0;
  for (const order of orders) {
    const { error: oErr } = await supabase
      .from("orders")
      .update({ assigned_advisor_id: membershipId })
      .eq("id", order.id)
      .eq("organization_id", organizationId);
    if (oErr) throw oErr;
    updated += 1;
    if (order.opportunity_id) {
      const { error: pErr } = await supabase
        .from("opportunities")
        .update({ assigned_advisor_id: membershipId })
        .eq("id", order.opportunity_id)
        .eq("organization_id", organizationId);
      if (pErr) throw pErr;
    }
  }
  return updated;
}
