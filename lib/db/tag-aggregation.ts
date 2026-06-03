import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { updateContact } from "@/lib/db/contacts";
import type { Json, UUID } from "@/lib/types/database";

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

function tagsInclude(tags: string[] | null, normalizedTag: string): boolean {
  return (tags ?? []).some((t) => normalizeTag(t) === normalizedTag);
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

// ============================================================
// Contactos (fix post-CHECKPOINT M7.2 #3)
// ============================================================

export interface ContactForReattribution {
  id: UUID;
  assigned_advisor_id: UUID | null;
  field_metadata: Json;
  last_whaapy_activity_at: string | null;
  last_modified_at: string;
  created_at: string;
  shopify_tags: string[] | null;
}

/**
 * Contactos cuya `shopify_tags` contiene la tag (match normalizado).
 * Trae los campos necesarios para decidir la re-atribución LWW-aware.
 */
export async function findContactsWithTag(
  normalizedTag: string,
): Promise<ContactForReattribution[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("id, assigned_advisor_id, field_metadata, last_whaapy_activity_at, last_modified_at, created_at, shopify_tags")
    .eq("organization_id", organizationId)
    .limit(SCAN_LIMIT);
  if (error) throw error;
  return ((data ?? []) as ContactForReattribution[]).filter((c) =>
    tagsInclude(c.shopify_tags, normalizedTag),
  );
}

/** Timestamp que representa "cuándo la tag pasó a ser fuente actual":
 *  el `updated_at` de la metadata de `shopify_tags`; si falta, cae a
 *  `last_modified_at` y luego `created_at`. */
function tagTimestamp(c: ContactForReattribution): string {
  const meta = c.field_metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const st = (meta as Record<string, unknown>).shopify_tags;
    if (st && typeof st === "object" && !Array.isArray(st)) {
      const ts = (st as { updated_at?: unknown }).updated_at;
      if (typeof ts === "string") return ts;
    }
  }
  return c.last_modified_at ?? c.created_at;
}

function withAdvisorMeta(meta: Json, updatedAt: string): Json {
  const base =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? { ...(meta as Record<string, Json>) }
      : ({} as Record<string, Json>);
  base.assigned_advisor_id = { updated_at: updatedAt, source: "shopify" } as Json;
  return base as Json;
}

/**
 * Re-atribuye contactos que llevan la tag al vendedor mapeado (R2 — la
 * tag de Shopify es fuente legítima de asignación del contacto, igual
 * que hace el parser en vivo). LWW-aware por campo `assigned_advisor_id`:
 *   - Ya == mapeado → no-op.
 *   - NULL → asigna (caso principal del bug: contactos con la tag sin asesor).
 *   - Difiere → solo pisa si la tag es MÁS RECIENTE que la última
 *     actividad Whaapy (`last_whaapy_activity_at`), proxy de una
 *     asignación Whaapy posterior (no existe field_metadata para
 *     assigned_advisor_id porque ningún worker lo escribe hoy — este
 *     re-proceso empieza a poblarlo para habilitar LWW futuro).
 * Devuelve el conteo de contactos efectivamente re-atribuidos.
 */
export async function reattributeContacts(
  contacts: ContactForReattribution[],
  membershipId: UUID | null,
): Promise<number> {
  if (!membershipId) return 0; // tag informativa no atribuye
  let updated = 0;
  for (const c of contacts) {
    if (c.assigned_advisor_id === membershipId) continue;
    const tagTs = tagTimestamp(c);
    if (c.assigned_advisor_id !== null && c.last_whaapy_activity_at) {
      const whaapyNewer =
        new Date(c.last_whaapy_activity_at).getTime() > new Date(tagTs).getTime();
      if (whaapyNewer) continue; // respetar asignación Whaapy más reciente
    }
    await updateContact(c.id, {
      assigned_advisor_id: membershipId,
      field_metadata: withAdvisorMeta(c.field_metadata, tagTs),
    });
    updated += 1;
  }
  return updated;
}
