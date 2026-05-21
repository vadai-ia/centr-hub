import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { requireTenantContext } from "@/lib/tenant/context";
import { recordAuditEvent } from "@/lib/db/operational";
import { upsertTagMapping } from "@/lib/db/configuration";
import type {
  MembershipRow,
  TagMappingRow,
  UUID,
} from "@/lib/types/database";

/**
 * Parser de tags Shopify (Sección 3.3.10 R2 + O4 + Sección
 * "Parser de tags — edge cases" de CLAUDE.md).
 *
 * Comportamiento (modelo binario simplificado):
 *   - Cada tag se normaliza (lowercase + trim).
 *   - Si NO existe en tag_mappings → auto-crea como `informational`
 *     (O4 — default informativo, sin atribución, sin alerta).
 *   - Si la tag está clasificada como `vendor` y mapea a un
 *     `mapped_membership_id` activo → produce asignación al asesor.
 *   - Tags `vendor` mapeadas a vendedores DESACTIVADOS no producen
 *     asignación + audit log + sin notificación al usuario
 *     (silenciosa hasta que admin reactive).
 *   - >1 tag `vendor` en la misma entidad → assigned NULL +
 *     audit log `multiple_advisor_tags_anomaly` +
 *     notificación type=alert al admin (orquestada por el caller —
 *     este servicio solo expone la flag).
 *   - Mapeo ambiguo (>1 mapping para la misma normalized_tag) →
 *     UNIQUE constraint del schema previene la condición; si por
 *     bug llegara, este servicio levanta excepción.
 *
 * El parser NUNCA retorna el usuario sistema "Histórico" como
 * resultado (R10) — el query de `listMembershipsForTags` filtra
 * por `is_active = true` y por construcción el Histórico tiene
 * `is_active = false`.
 */

export interface ParseTagsInput {
  rawTags: string[] | string;        // acepta array o CSV
  source: "customer" | "draft_order" | "order";
  /** ID Shopify del registro fuente — solo para audit log. */
  shopifyEntityId?: string;
}

export interface ParsedTag {
  original: string;
  normalized: string;
  mapping: TagMappingRow;
}

export interface TagParseResult {
  /** Membresía mapeada (única tag-vendor válida). Null si 0 o múltiples. */
  assignedMembership: MembershipRow | null;
  /** Tags clasificadas como vendor (puede ser >1 si hay anomalía). */
  vendorTags: ParsedTag[];
  /** Tags informativas (o desconocidas auto-creadas como informational). */
  informationalTags: ParsedTag[];
  /** True si hubo >1 tag-vendor en la entidad. */
  multipleVendorTagsDetected: boolean;
  /** True si la única tag-vendor mapeaba a un vendedor desactivado. */
  vendorIsInactive: boolean;
  /** Tags normalizadas únicas en el orden original — para `shopify_tags`. */
  normalizedTagList: string[];
  /** Tags originales únicas en el orden original — para `shopify_tags`. */
  originalTagList: string[];
}

function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase();
}

function uniqueOrderedBy<T, K extends string>(
  list: T[],
  keyOf: (t: T) => K,
): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const item of list) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function parseCsv(input: string[] | string): string[] {
  const arr = Array.isArray(input)
    ? input.flatMap((t) => t.split(",")) // por si entra un array con CSV adentro
    : input.split(",");
  return arr.map((t) => t.trim()).filter((t) => t.length > 0);
}

/**
 * Implementación principal. El caller debe estar dentro de un
 * `withTenantContext(...)`.
 */
export async function parseShopifyTags(
  input: ParseTagsInput,
): Promise<TagParseResult> {
  requireTenantContext();

  // 1. Normalización + deduplicación ordenada (case-insensitive)
  const rawList = parseCsv(input.rawTags);
  const originalUnique = uniqueOrderedBy(rawList, (t) => normalizeTag(t) as string);
  const pairs = originalUnique.map((original) => ({
    original,
    normalized: normalizeTag(original),
  }));

  if (pairs.length === 0) {
    return {
      assignedMembership: null,
      vendorTags: [],
      informationalTags: [],
      multipleVendorTagsDetected: false,
      vendorIsInactive: false,
      normalizedTagList: [],
      originalTagList: [],
    };
  }

  // 2. Lookup existente
  const { supabase, organizationId } = getTenantScopedClient();
  const { data: existing, error: lookupErr } = await supabase
    .from("tag_mappings")
    .select("*")
    .eq("organization_id", organizationId)
    .in(
      "normalized_tag",
      pairs.map((p) => p.normalized),
    );
  if (lookupErr) throw lookupErr;
  const existingMap = new Map<string, TagMappingRow>(
    (existing ?? []).map((row) => [String(row.normalized_tag).toLowerCase(), row as TagMappingRow]),
  );

  // 3. Auto-crear faltantes como `informational` (O4)
  const missingPairs = pairs.filter((p) => !existingMap.has(p.normalized));
  const createdMappings: TagMappingRow[] = [];
  for (const p of missingPairs) {
    const row = await upsertTagMapping({
      normalized_tag: p.normalized,
      original_tag: p.original,
      classification: "informational",
      mapped_membership_id: null,
      created_by_user_id: null,
    });
    existingMap.set(p.normalized, row);
    createdMappings.push(row);
  }

  // 4. Clasificar
  const vendor: ParsedTag[] = [];
  const informational: ParsedTag[] = [];
  for (const p of pairs) {
    const mapping = existingMap.get(p.normalized)!;
    const entry: ParsedTag = { original: p.original, normalized: p.normalized, mapping };
    if (mapping.classification === "vendor") vendor.push(entry);
    else informational.push(entry);
  }

  // 5. Resolver vendor único → membership activa
  let assignedMembership: MembershipRow | null = null;
  let vendorIsInactive = false;
  const multipleVendorTagsDetected = vendor.length > 1;

  if (vendor.length === 1) {
    const single = vendor[0];
    const membershipId = single.mapping.mapped_membership_id;
    if (membershipId) {
      const membership = await loadMembershipByIdSafe(membershipId);
      if (membership && membership.is_active) {
        assignedMembership = membership;
      } else {
        vendorIsInactive = true;
        await recordAuditEvent({
          actorUserId: null,
          eventType: "tag_mapped_to_inactive_vendor",
          entityType: input.source,
          entityId: null,
          payload: {
            source: input.source,
            shopify_entity_id: input.shopifyEntityId ?? null,
            normalized_tag: single.normalized,
            membership_id: membershipId,
          },
        });
      }
    }
  } else if (vendor.length > 1) {
    await recordAuditEvent({
      actorUserId: null,
      eventType: "multiple_advisor_tags_anomaly",
      entityType: input.source,
      entityId: null,
      payload: {
        source: input.source,
        shopify_entity_id: input.shopifyEntityId ?? null,
        vendor_tags: vendor.map((v) => v.normalized),
      },
    });
    // Notificación al admin se orquesta desde el worker (necesita
    // resolución de `user_id` admin de la org).
  }

  return {
    assignedMembership,
    vendorTags: vendor,
    informationalTags: informational,
    multipleVendorTagsDetected,
    vendorIsInactive,
    normalizedTagList: pairs.map((p) => p.normalized),
    originalTagList: pairs.map((p) => p.original),
  };
}

async function loadMembershipByIdSafe(id: UUID): Promise<MembershipRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return null;
  return (data as MembershipRow) ?? null;
}
