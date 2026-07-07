/**
 * Decisión PURA de matching del backfill M11 — sin DB, sin I/O, testeable.
 *
 * Reglas locked en `CENTR-M11-BACKFILL-DESIGN.md` §3-§4:
 *   - Dedup por `shopify_customer_id` (`existsByCustomerId`) → update
 *     idempotente (re-run = no crea fila nueva).
 *   - Tier-phone enlaza SOLO a leads (el caller ya filtró a contactos con
 *     `shopify_customer_id IS NULL` y quitó los consumidos en este run):
 *     1 lead → link; >1 → conflict; 0 → cae a email.
 *   - Placeholder: el caller pasa `effectivePhone = null` (un número
 *     compartido por ≥N customers no actúa como clave de match), así que
 *     un customer con placeholder nunca enlaza por teléfono.
 *
 * Invariante de correctitud (previene el merge-collapse — ver ERRORES.md):
 *   la decisión NUNCA enlaza contra un contacto que ya carga otro
 *   `shopify_customer_id`, porque solo recibe IDs de leads. Dos customers
 *   de Shopify que comparten teléfono → cada uno crea su propia fila.
 */

export type BackfillContactAction =
  | { kind: "update" }
  | { kind: "link"; leadId: string; matchBy: "phone" | "email" }
  | { kind: "conflict"; matchBy: "phone" | "email" }
  | { kind: "create" };

export interface BackfillContactDecisionInput {
  /** True si ya existe un contacto local con este `shopify_customer_id`. */
  existsByCustomerId: boolean;
  /** Teléfono E.164 efectivo — `null` si placeholder o inexistente. */
  effectivePhone: string | null;
  /** Email normalizado efectivo — `null` si inexistente. */
  effectiveEmail: string | null;
  /** IDs de LEADS (sin `shopify_customer_id`, no consumidos) con ese teléfono. */
  leadIdsByPhone: string[];
  /** IDs de LEADS con ese email. */
  leadIdsByEmail: string[];
}

export function decideBackfillContactAction(
  i: BackfillContactDecisionInput,
): BackfillContactAction {
  if (i.existsByCustomerId) return { kind: "update" };

  if (i.effectivePhone) {
    if (i.leadIdsByPhone.length === 1) {
      return { kind: "link", leadId: i.leadIdsByPhone[0], matchBy: "phone" };
    }
    if (i.leadIdsByPhone.length > 1) {
      return { kind: "conflict", matchBy: "phone" };
    }
  }

  if (i.effectiveEmail) {
    if (i.leadIdsByEmail.length === 1) {
      return { kind: "link", leadId: i.leadIdsByEmail[0], matchBy: "email" };
    }
    if (i.leadIdsByEmail.length > 1) {
      return { kind: "conflict", matchBy: "email" };
    }
  }

  return { kind: "create" };
}

/**
 * Resuelve el teléfono efectivo: `null` si es placeholder (compartido por
 * ≥ umbral customers). Devuelve también el flag para el reporte.
 */
export function resolveEffectivePhone(
  normalizedPhone: string | null,
  placeholderPhones: ReadonlySet<string>,
): { effectivePhone: string | null; isPlaceholder: boolean } {
  if (normalizedPhone && placeholderPhones.has(normalizedPhone)) {
    return { effectivePhone: null, isPlaceholder: true };
  }
  return { effectivePhone: normalizedPhone, isPlaceholder: false };
}

/**
 * Set de teléfonos placeholder desde la frecuencia por teléfono: los que
 * aparecen en ≥ `minShare` customers distintos.
 */
export function computePlaceholderPhones(
  phoneFrequency: ReadonlyMap<string, number>,
  minShare: number,
): Set<string> {
  const out = new Set<string>();
  phoneFrequency.forEach((count, phone) => {
    if (count >= minShare) out.add(phone);
  });
  return out;
}
