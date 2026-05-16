import "server-only";
import { requireTenantContext } from "@/lib/tenant/context";
import type { TagMappingRow, MembershipRow } from "@/lib/types/database";

/**
 * Parser de tags de Shopify (Sección 3.3.10 R2 + O4).
 *
 * Stub para M1 — la implementación viva en M3 (sincronización
 * Shopify). El parser:
 *   - Normaliza la tag (lowercase + trim).
 *   - Si no existe en `tag_mappings`, la crea como `informational`
 *     por default (O4).
 *   - Si la tag está clasificada como `vendor` y mapea a un
 *     `mapped_membership_id` activo, retorna asignación del asesor.
 *   - Si mapea a un vendedor desactivado, retorna asignación nula
 *     y loguea `tag_mapped_to_inactive_vendor`.
 *   - Si múltiples tags-vendor aparecen en la misma entidad, M3
 *     decide cuál gana y emite notificación `alert` al admin con
 *     payload de las tags involucradas.
 *
 * IMPORTANTE — R10: el usuario sistema "Histórico" NUNCA es
 * resultado del parser. El parser solo asigna a vendedores reales
 * con membresía activa.
 */

export interface TagParseResult {
  /** Membresía mapeada (si la tag está clasificada como `vendor` y activa). */
  assignedMembership: MembershipRow | null;
  /** Tags normalizadas que el parser detectó como `vendor`. */
  vendorTags: TagMappingRow[];
  /** Tags normalizadas reflejadas como informativas. */
  informationalTags: TagMappingRow[];
  /** Indica si hubo conflicto (>1 tag-vendor en la misma entidad). */
  multipleVendorTagsDetected: boolean;
}

export interface ParseTagsInput {
  rawTags: string[];
  /** Quién creó/actualizó la entidad — para audit en M3. */
  source: "customer" | "draft_order" | "order";
}

export async function parseShopifyTags(_input: ParseTagsInput): Promise<TagParseResult> {
  // requireTenantContext: si alguien llama al parser sin contexto,
  // que truene aquí (Barrera 2 — R6).
  requireTenantContext();
  throw new Error("tag-parser: implementación pendiente (M3)");
}
