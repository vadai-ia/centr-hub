import type { ISODateString, UUID } from "@/lib/types/database";
import type { AdvisorOption } from "@/lib/actions/contacts";

/**
 * Helpers de display del listado y detalle de Contactos (M6 — B2/B3).
 *
 * Los helpers aceptan formas estructurales (Pick<>) en lugar de un
 * Row específico, de modo que tanto `ContactListRow` (B2) como
 * `ContactRow` (B3 desde detail) puedan usarlos sin mapping manual.
 */

export interface AdvisorDisplay {
  fullName: string;
  color: string;
  isUnassigned: boolean;
}

const UNASSIGNED: AdvisorDisplay = {
  fullName: "Sin asignar",
  color: "#9CA3AF",
  isUnassigned: true,
};

export function resolveAdvisor(
  membershipId: UUID | null,
  advisors: AdvisorOption[],
): AdvisorDisplay {
  if (!membershipId) return UNASSIGNED;
  const found = advisors.find((a) => a.membershipId === membershipId);
  if (!found) {
    return { fullName: "Asesor histórico", color: "#9CA3AF", isUnassigned: false };
  }
  return { fullName: found.fullName, color: found.color, isUnassigned: false };
}

/** Campos mínimos que el helper de display necesita. */
export interface ContactNameShape {
  id: UUID;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  anonymized_at: ISODateString | null;
}

/** Nombre mostrable del contacto. */
export function contactDisplayName(row: ContactNameShape): string {
  if (row.anonymized_at) {
    return `Cliente anonimizado #${row.id.slice(0, 8)}`;
  }
  if (row.full_name && row.full_name.trim()) return row.full_name;
  if (row.email) return row.email;
  if (row.phone) return row.phone;
  return "Contacto sin nombre";
}

/**
 * Última actividad: prefiere `last_whaapy_activity_at` (más reciente
 * y relevante operativamente) si existe; si no, `last_modified_at`.
 */
export function lastActivityISO(row: {
  last_modified_at: ISODateString;
  last_whaapy_activity_at: ISODateString | null;
}): string {
  return row.last_whaapy_activity_at ?? row.last_modified_at;
}

/**
 * Formato relativo en español ("hace 3 días", "hoy", "ayer").
 * Sin libs externas — los formatos son operativos, no precisos.
 */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 0) return "en el futuro";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "hace instantes";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return days === 1 ? "ayer" : `hace ${days} días`;
  // > 7 días → fecha corta
  return then.toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    year: then.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

export interface SystemIndicators {
  inShopify: boolean;
  inWhaapy: boolean;
  /** Forma: solo-shopify / solo-whaapy / ambos / ninguno (raro). */
  presence: "shopify_only" | "whaapy_only" | "both" | "none";
}

/**
 * Convierte el `address` jsonb del contacto a un string legible en
 * línea única. Acepta varias formas comunes (line1/address1, city,
 * state, country, zip/postal_code) y filtra valores vacíos.
 */
export function formatAddress(address: unknown): string | null {
  if (!address || typeof address !== "object") return null;
  const obj = address as Record<string, unknown>;
  const ordered = [
    obj.line1,
    obj.line2,
    obj.address1,
    obj.address2,
    obj.city,
    obj.state,
    obj.province,
    obj.country,
    obj.zip,
    obj.postal_code,
  ];
  const parts = ordered
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

export function systemIndicators(row: {
  shopify_customer_id: string | null;
  whaapy_contact_id: string | null;
}): SystemIndicators {
  const inShopify = row.shopify_customer_id !== null;
  const inWhaapy = row.whaapy_contact_id !== null;
  let presence: SystemIndicators["presence"] = "none";
  if (inShopify && inWhaapy) presence = "both";
  else if (inShopify) presence = "shopify_only";
  else if (inWhaapy) presence = "whaapy_only";
  return { inShopify, inWhaapy, presence };
}
