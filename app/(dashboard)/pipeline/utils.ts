import type { KanbanOpportunity } from "@/lib/db/opportunities";
import type { AdvisorOption } from "@/lib/types/pipeline";

/**
 * Helpers presentacionales del kanban — extraídos para evitar lógica
 * inline en componentes y para mantener archivos <300 líneas.
 */

/**
 * Formatea un monto pg numeric (string) en MXN. Para otras monedas
 * el currency code pasa a `Intl.NumberFormat`. Si la string está
 * vacía o nula devuelve null para que el caller decida cómo renderiza
 * el ausente (badge "Sin monto" vs guion vs vacío).
 */
export function formatAmount(
  amount: string | null,
  currency: string = "MXN",
): string | null {
  if (amount === null || amount === undefined || amount === "") return null;
  const num = Number(amount);
  if (!Number.isFinite(num)) return null;
  try {
    return new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(num);
  } catch {
    return `${currency} ${num.toLocaleString("es-MX")}`;
  }
}

/**
 * Lógica de "qué monto mostrar en la card":
 *  - Si actual_amount existe → ese (color normal).
 *  - Si solo estimated_amount existe → ese (color o badge estimado).
 *  - Si ninguno → null + flag isMissing para que la card pinte
 *    "Sin monto" en lugar de "$0".
 */
export interface DisplayAmount {
  text: string;
  isEstimated: boolean;
  isMissing: boolean;
}

export function deriveDisplayAmount(opp: KanbanOpportunity): DisplayAmount {
  const actual = formatAmount(opp.actual_amount, opp.currency);
  if (actual) return { text: actual, isEstimated: false, isMissing: false };
  const estimated = formatAmount(opp.estimated_amount, opp.currency);
  if (estimated) return { text: estimated, isEstimated: true, isMissing: false };
  return { text: "Sin monto", isEstimated: false, isMissing: true };
}

/**
 * Origen visual de la opp: "Shopify" si tiene Draft Order asociada
 * (vino de un Draft Order, lo más común), "Whaapy/Auto" si nació
 * via auto-creación C2 sin Draft Order. La distinción ayuda al
 * vendedor a saber qué tan "calificada" está la opp antes del click.
 */
export type OriginIndicator = "shopify" | "whaapy_or_auto";

export function deriveOriginIndicator(opp: KanbanOpportunity): OriginIndicator {
  if (opp.shopify_draft_order_id || opp.shopify_order_id) return "shopify";
  return "whaapy_or_auto";
}

/**
 * Resuelve el nombre del asesor para pintar en la card (vista admin)
 * o en el quick-view (siempre). Devuelve "Sin asignar" cuando la opp
 * no tiene `assigned_advisor_id` — caso real validado en CHECKPOINT M4.
 */
export interface ResolvedAdvisor {
  fullName: string;
  color: string;
  isUnassigned: boolean;
}

export function resolveAdvisor(
  assignedAdvisorId: string | null,
  advisors: AdvisorOption[],
): ResolvedAdvisor {
  if (!assignedAdvisorId) {
    return { fullName: "Sin asignar", color: "#94A3B8", isUnassigned: true };
  }
  const match = advisors.find((a) => a.membershipId === assignedAdvisorId);
  if (!match) {
    // El advisor existe en BD pero no está en el dropdown (ej. ya no
    // está activo). Mostramos genérico para no romper la card.
    return { fullName: "Asesor", color: "#94A3B8", isUnassigned: false };
  }
  return {
    fullName: match.fullName,
    color: match.color,
    isUnassigned: false,
  };
}

/**
 * Display name del contacto — full_name si existe; si no, phone
 * formateado; si tampoco, "Contacto sin nombre". El email es fallback
 * de última instancia.
 */
export function contactDisplayName(
  contact: KanbanOpportunity["contact"],
): string {
  if (!contact) return "Contacto desconocido";
  if (contact.full_name && contact.full_name.trim()) {
    return contact.full_name.trim();
  }
  if (contact.phone && contact.phone.trim()) return contact.phone.trim();
  if (contact.email && contact.email.trim()) return contact.email.trim();
  return "Contacto sin nombre";
}

/**
 * Clasificación lead vs cliente derivada (O12 — doctrina v5.1).
 * "Cliente" si el contact tiene `shopify_customer_id`; "lead" si no.
 */
export function contactIsCustomer(
  contact: KanbanOpportunity["contact"],
): boolean {
  return !!contact?.shopify_customer_id;
}
