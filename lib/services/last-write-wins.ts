import "server-only";
import { requireTenantContext } from "@/lib/tenant/context";
import type { ContactRow, Json } from "@/lib/types/database";

/**
 * Last-write-wins (R3 + Ajuste post-Discovery 2 #14).
 *
 * Granularidad diferenciada:
 *   - Draft Orders / Orders: LWW a nivel REGISTRO completo
 *     (fuente única Shopify). Implementación en M3.
 *   - Contacts: LWW POR CAMPO. Implementación en M3 (Shopify
 *     inbound), M4 (Whaapy inbound) y M6 (edición manual).
 *
 * Excepción del match inicial: cuando contacto Shopify hace match
 * con contacto Whaapy por primera vez, los campos Shopify
 * prevalecen pero valores VACÍOS en Shopify NO borran valores
 * existentes en Whaapy. Después del match, LWW por campo universal
 * con borrados propagados (R3).
 *
 * Estructura de `field_metadata` JSONB:
 *   {
 *     "full_name": { "updated_at": "2026-05-01T...", "source": "shopify" },
 *     "email":     { "updated_at": "2026-05-02T...", "source": "whaapy" },
 *     ...
 *   }
 */

export type ContactFieldSource = "shopify" | "whaapy" | "platform";

export interface FieldUpdateProposal {
  field: keyof ContactRow;
  value: unknown;          // nullable: borrado intencional
  updatedAt: string;       // ISO timestamp del payload externo
  source: ContactFieldSource;
}

export interface FieldUpdateResult {
  applied: boolean;
  reason: "newer" | "older_ignored" | "initial_match_shopify_priority" | "empty_overwrite";
}

/**
 * Decide si aplicar `proposal` sobre `current.field_metadata`.
 * Stub para M1 — la lógica concreta vive en M3/M4/M6.
 */
export function reconcileContactField(
  _current: ContactRow,
  _proposal: FieldUpdateProposal,
  _isInitialMatch: boolean,
): FieldUpdateResult {
  throw new Error("last-write-wins: implementación pendiente (M3/M4/M6)");
}

/**
 * LWW a nivel registro. Devuelve true si el payload debe aplicarse
 * (su `updated_at` es más reciente que el local). Usado por M3
 * para Draft Orders y Orders.
 */
export function shouldApplyRecordUpdate(
  localUpdatedAt: string | null,
  payloadUpdatedAt: string | null,
): boolean {
  requireTenantContext();
  if (!payloadUpdatedAt) return false;
  if (!localUpdatedAt) return true;
  return new Date(payloadUpdatedAt).getTime() > new Date(localUpdatedAt).getTime();
}

/**
 * Aux: crea un patch de `field_metadata` con la entrada actualizada
 * para `field` (preservando lo demás).
 */
export function buildFieldMetadataPatch(
  current: Json,
  field: string,
  updatedAt: string,
  source: ContactFieldSource,
): Json {
  const obj = (current && typeof current === "object" && !Array.isArray(current)
    ? { ...(current as Record<string, Json>) }
    : {}) as Record<string, Json>;
  obj[field] = { updated_at: updatedAt, source };
  return obj as Json;
}
