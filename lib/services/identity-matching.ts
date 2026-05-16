import "server-only";
import { requireTenantContext } from "@/lib/tenant/context";
import type { ContactRow } from "@/lib/types/database";

/**
 * Identity matching de contactos (Sección 3.3.3 + 3.6).
 *
 * Stub para M1 — implementación en M3 (Shopify inbound) y M4
 * (Whaapy inbound). El servicio normaliza identificadores y
 * busca contacto local existente; si match, enlaza la identidad
 * faltante al contacto existente (NO crea duplicado) y dispara
 * propagación al sistema que faltaba.
 *
 * Normalización:
 *   - phone → E.164 (libphonenumber u análogo en M3)
 *   - email → lowercase + trim
 */

export interface IdentityMatchInput {
  source: "shopify" | "whaapy";
  shopifyCustomerId?: string | null;
  whaapyContactId?: string | null;
  phone?: string | null;          // normalizar a E.164
  email?: string | null;          // normalizar lowercase
}

export interface IdentityMatchResult {
  /** Contacto existente encontrado por identidad externa. */
  contactByExternalId: ContactRow | null;
  /** Contacto existente encontrado por phone/email cruzado. */
  contactByCrossChannel: ContactRow | null;
  /** Acción recomendada: link | create | update. */
  recommendation: "link" | "create" | "update_existing";
}

export async function matchContactIdentity(
  _input: IdentityMatchInput,
): Promise<IdentityMatchResult> {
  requireTenantContext();
  throw new Error("identity-matching: implementación pendiente (M3/M4)");
}

/** Helper para normalizar email (consistente entre M3 y M4). */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}
