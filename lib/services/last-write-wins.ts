import "server-only";
import { requireTenantContext } from "@/lib/tenant/context";
import type { ContactRow, Json } from "@/lib/types/database";

/**
 * Last-write-wins refinado (R3 + Ajuste post-Discovery 2 #14).
 *
 * Granularidad:
 *   - Draft Orders y Orders → LWW por REGISTRO (fuente única
 *     Shopify). Usa `shouldApplyRecordUpdate`.
 *   - Contacts → LWW POR CAMPO con `field_metadata` JSONB.
 *     Usa `reconcileContactFields` (procesa varios campos juntos
 *     en una sola pasada).
 *
 * Borrados intencionales:
 *   - Campo editable que llega vacío en update más reciente:
 *     vacío SOBRESCRIBE valor existente. El usuario pudo borrarlo
 *     deliberadamente; preservar lo previo contradice la intención.
 *   - Identificadores externos (`shopify_customer_id`,
 *     `whaapy_contact_id`): NO se borran nunca por LWW. Esos
 *     enlaces se gestionan explícitamente.
 *
 * Excepción del match inicial (v5.1):
 *   - Shopify → Whaapy automático: Shopify llena la creación.
 *   - Whaapy → Shopify manual vía botón: el vendedor decide.
 *   - Match defensivo (enlace de customer Shopify pre-existente):
 *     campos del customer Shopify ganan pero VACÍOS no borran
 *     valores del maestro/Whaapy.
 *
 * Estructura de `field_metadata`:
 *   {
 *     "full_name": { "updated_at": "2026-05-01T...", "source": "shopify" },
 *     "email":     { "updated_at": "2026-05-02T...", "source": "whaapy" },
 *     ...
 *   }
 */

export type ContactFieldSource = "shopify" | "whaapy" | "platform";

const EDITABLE_FIELDS = [
  "full_name",
  "email",
  "phone",
  "address",
  "internal_note",
  "shopify_state",
  "shopify_tags",
  "assigned_advisor_id",
] as const;

export type EditableContactField = (typeof EDITABLE_FIELDS)[number];

const NEVER_OVERWRITE_BY_LWW = new Set<string>([
  "shopify_customer_id",
  "whaapy_contact_id",
]);

// Campos cuya columna es `NOT NULL` array (text[]) en la BD. Para
// estos, la representación de "vacío" es `[]`, no `null` — un
// patch con `null` rompería la NOT NULL constraint (ver
// contacts.shopify_tags, migración 0003). La semántica doctrinal
// "empty overwrites" se mantiene: `[]` sobrescribe `["X"]` cuando
// la propuesta es más reciente; solo cambia el storage.
const ARRAY_TYPED_FIELDS = new Set<string>(["shopify_tags"]);

function emptyValueFor(field: string): unknown {
  return ARRAY_TYPED_FIELDS.has(field) ? [] : null;
}

export interface FieldProposal {
  field: EditableContactField;
  value: unknown; // null/undefined/"" representan borrado intencional
  updatedAt: string;
  source: ContactFieldSource;
}

export interface FieldDecision {
  field: EditableContactField;
  applied: boolean;
  reason:
    | "first_value"
    | "newer"
    | "older_ignored"
    | "initial_match_shopify_priority"
    | "initial_match_preserve_value"
    | "empty_overwrite"
    | "blocked_external_id"
    /**
     * Campo local YA vacío + propuesta vacía → no se escribe ni
     * patch ni metadata. Evita "sellar" un campo vacío con un
     * timestamp que después bloquearía propuestas legítimas
     * con el mismo `updated_at` (older_ignored). Ver ERRORES.md
     * "LWW seal por proposals vacíos…".
     */
    | "noop_both_empty";
  finalValue?: unknown;
}

export interface ReconcileResult {
  /** Patch listo para `.update(...)` en la tabla contacts. */
  patch: Record<string, unknown>;
  /** Nueva metadata por campo para guardar en `field_metadata`. */
  nextFieldMetadata: Json;
  /** Decisiones tomadas — útil para audit log y debugging. */
  decisions: FieldDecision[];
}

interface FieldMetaEntry {
  updated_at: string;
  source: ContactFieldSource;
}

function readMeta(meta: Json, field: string): FieldMetaEntry | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const obj = (meta as Record<string, Json>)[field];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const entry = obj as { updated_at?: unknown; source?: unknown };
  if (typeof entry.updated_at !== "string" || typeof entry.source !== "string") {
    return null;
  }
  return { updated_at: entry.updated_at, source: entry.source as ContactFieldSource };
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/**
 * Decide si aplicar un conjunto de proposals sobre un contacto.
 * `isInitialMatch=true` aplica únicamente cuando es la PRIMERA
 * vez que se enlaza una identidad externa al contacto existente
 * (match defensivo Shopify pre-existente, en M6).
 */
export function reconcileContactFields(
  current: ContactRow,
  proposals: FieldProposal[],
  options: { isInitialMatch?: boolean } = {},
): ReconcileResult {
  const patch: Record<string, unknown> = {};
  const decisions: FieldDecision[] = [];
  let nextMeta: Record<string, Json> = {};
  if (current.field_metadata && typeof current.field_metadata === "object" && !Array.isArray(current.field_metadata)) {
    nextMeta = { ...(current.field_metadata as Record<string, Json>) };
  }

  for (const proposal of proposals) {
    const field = proposal.field;

    if (NEVER_OVERWRITE_BY_LWW.has(field as string)) {
      decisions.push({ field, applied: false, reason: "blocked_external_id" });
      continue;
    }

    const meta = readMeta(current.field_metadata, field);
    const currentValue = (current as unknown as Record<string, unknown>)[field];
    const currentEmpty = isEmptyValue(currentValue);
    const proposalEmpty = isEmptyValue(proposal.value);
    const normalizedValue = proposalEmpty ? emptyValueFor(field) : proposal.value;

    // Anti-sealing: si el campo local YA está vacío y la propuesta
    // también, NO escribimos patch ni metadata. Escribir metadata
    // aquí sella el campo para LWW: una propuesta posterior con el
    // mismo `updated_at` (común en re-fetches del mismo recurso o
    // re-emisión de webhooks) se rechazaría como `older_ignored` y
    // el campo quedaría vacío de forma permanente aunque el dato
    // real esté disponible en la fuente.
    //
    // R3 (borrados intencionales propagados) queda intacto: cuando
    // el campo local TIENE valor y la propuesta vacía es MÁS
    // RECIENTE, abajo cae en `empty_overwrite` que sí escribe meta
    // + patch para que un valor viejo no pueda refile-arlo.
    //
    // Ver ERRORES.md "LWW seal por proposals vacíos…" para el
    // caso productivo (104 contactos con phone=null sellados por
    // field_metadata.phone={source:shopify}).
    if (currentEmpty && proposalEmpty) {
      decisions.push({ field, applied: false, reason: "noop_both_empty" });
      continue;
    }

    // Caso especial: match inicial (v5.1)
    if (options.isInitialMatch && proposal.source === "shopify") {
      if (proposalEmpty && !isEmptyValue(currentValue)) {
        decisions.push({
          field,
          applied: false,
          reason: "initial_match_preserve_value",
        });
        continue;
      }
      patch[field] = normalizedValue;
      nextMeta[field] = {
        updated_at: proposal.updatedAt,
        source: proposal.source,
      } as Json;
      decisions.push({
        field,
        applied: true,
        reason: "initial_match_shopify_priority",
        finalValue: normalizedValue,
      });
      continue;
    }

    if (!meta) {
      patch[field] = normalizedValue;
      nextMeta[field] = {
        updated_at: proposal.updatedAt,
        source: proposal.source,
      } as Json;
      decisions.push({
        field,
        applied: true,
        reason: "first_value",
        finalValue: normalizedValue,
      });
      continue;
    }

    const isNewer =
      new Date(proposal.updatedAt).getTime() > new Date(meta.updated_at).getTime();
    if (!isNewer) {
      decisions.push({ field, applied: false, reason: "older_ignored" });
      continue;
    }

    patch[field] = normalizedValue;
    nextMeta[field] = {
      updated_at: proposal.updatedAt,
      source: proposal.source,
    } as Json;
    decisions.push({
      field,
      applied: true,
      reason: proposalEmpty ? "empty_overwrite" : "newer",
      finalValue: normalizedValue,
    });
  }

  return { patch, nextFieldMetadata: nextMeta as Json, decisions };
}

/**
 * LWW a nivel registro completo. Usado por workers de Draft Order
 * y Order. `localUpdatedAt` puede venir de `orders.updated_at` o
 * `opportunities.last_modified_at`.
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
 * Compatibilidad con tests M1 — alias preserva firma anterior.
 */
export function buildFieldMetadataPatch(
  current: Json,
  field: string,
  updatedAt: string,
  source: ContactFieldSource,
): Json {
  const obj =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, Json>) }
      : ({} as Record<string, Json>);
  obj[field] = { updated_at: updatedAt, source } as Json;
  return obj as Json;
}

/** Re-export del tipo legacy para compatibilidad. */
export interface FieldUpdateProposal {
  field: keyof ContactRow;
  value: unknown;
  updatedAt: string;
  source: ContactFieldSource;
}

export interface FieldUpdateResult {
  applied: boolean;
  reason: FieldDecision["reason"];
}

/** Helper legacy preservado por backward compat — usa el nuevo reconciler. */
export function reconcileContactField(
  current: ContactRow,
  proposal: FieldUpdateProposal,
  isInitialMatch: boolean,
): FieldUpdateResult {
  const result = reconcileContactFields(
    current,
    [proposal as FieldProposal],
    { isInitialMatch },
  );
  const decision = result.decisions[0];
  return { applied: decision.applied, reason: decision.reason };
}
