import "server-only";
// IMPORTANTE: importamos de `libphonenumber-js/core` con metadata
// pasada explícita, NO del top-level `libphonenumber-js`. Razón:
// el bundle top-level usa un require dinámico de `metadata.min.json`
// que tsx 4.19.x rompe silenciosamente bajo Node 24 (dual ESM/CJS
// interop bug — el require devuelve undefined). Productive code en
// Next.js y Vitest cargan el top-level sin problema, pero el script
// de operaciones (`scripts/shopify/rehydrate-empty-contacts.ts`)
// corre bajo tsx y todo `parsePhoneNumberFromString` tiraba un
// TypeError silencioso. Ver ERRORES.md "normalizePhone perdía
// teléfonos en silencio bajo tsx por bug de bundling…".
//
// Usar `/core` + import directo del JSON evita el require dinámico
// — los tres runtimes (Next.js, Vitest, tsx) ahora cargan metadata
// del mismo modo y `parsePhoneNumberFromString` funciona en todos.
import {
  parsePhoneNumberFromString,
  type CountryCode,
  type MetadataJson,
} from "libphonenumber-js/core";
import metadata from "libphonenumber-js/metadata.min.json";
import { getTenantScopedClient } from "@/lib/db/client";
import { requireTenantContext } from "@/lib/tenant/context";
import { recordAuditEvent } from "@/lib/db/operational";
import type { ContactRow, UUID } from "@/lib/types/database";

/**
 * Identity matching (Sección 3.3.3 + 3.6).
 *
 * Orden de match para inbound:
 *   1. shopifyCustomerId o whaapyContactId (identidad externa directa).
 *   2. phone (normalizado a E.164, default MX).
 *   3. email (normalizado lowercase + trim).
 * Si dos contactos diferentes hacen match cruzado (uno por
 * phone, otro por email) → NO fusionar — registra `identity_match_conflict`
 * + retorna recomendación `conflict_create_new`.
 */

export type IdentitySource = "shopify" | "whaapy";

export interface IdentityMatchInput {
  source: IdentitySource;
  shopifyCustomerId?: string | null;
  whaapyContactId?: string | null;
  phone?: string | null;
  email?: string | null;
  /** País default para normalización de phone. Default 'MX'. */
  defaultCountry?: CountryCode;
}

export type MatchRecommendation =
  | "link_external_id"            // contacto existente — enlazar identidad faltante
  | "update_by_external_id"       // contacto existente — ya tenía la identidad
  | "create_new"                  // no hay match — crear contacto nuevo
  | "conflict_create_new";        // dos contactos cruzados — crear nuevo + audit

export interface IdentityMatchResult {
  recommendation: MatchRecommendation;
  match: ContactRow | null;
  normalizedPhone: string | null;
  normalizedEmail: string | null;
  /** True si no tiene phone ni email — el caller decide cómo proceder. */
  hadStrongIdentifiers: boolean;
}

export function normalizePhone(
  raw: string | null | undefined,
  defaultCountry: CountryCode = "MX",
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let phone: ReturnType<typeof parsePhoneNumberFromString>;
  try {
    phone = parsePhoneNumberFromString(
      trimmed,
      defaultCountry,
      metadata as unknown as MetadataJson,
    );
  } catch (err) {
    // `parsePhoneNumberFromString` está documentado para NO tirar
    // excepciones (devuelve `undefined` para inputs inparseables y
    // un objeto con `isValid()=false` para números inválidos). Si
    // llegamos acá es una excepción inesperada del runtime — bug
    // del bundler, metadata corrupta, o regresión de la librería.
    // NO se debe tragar: gritamos por stderr (Inngest/Vercel logs
    // lo capturan) y re-lanzamos para que el caller falle en lugar
    // de persistir `null` en silencio.
    //
    // El silencio era exactamente el modo de falla del bug previo
    // bajo tsx (`Cannot read properties of undefined…`). Toda
    // llamada devolvía null, la rama empty-on-empty del reconciler
    // descartaba el proposal, y los teléfonos se perdían sin trace.
    // Ver ERRORES.md "normalizePhone perdía teléfonos en silencio
    // bajo tsx".
    // eslint-disable-next-line no-console
    console.error(
      "normalizePhone: excepción inesperada de parsePhoneNumberFromString",
      {
        rawSample: trimmed.slice(0, 32),
        defaultCountry,
        error: (err as Error)?.message ?? String(err),
      },
    );
    throw err;
  }
  // Inputs inparseables o números inválidos → null silencioso
  // (comportamiento documentado: el caller decide qué hacer con
  // un teléfono no normalizable).
  if (!phone) return null;
  if (!phone.isValid()) return null;
  return phone.number; // E.164
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

async function findByExternalId(
  source: IdentitySource,
  externalId: string,
): Promise<ContactRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const column = source === "shopify" ? "shopify_customer_id" : "whaapy_contact_id";
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", organizationId)
    .eq(column, externalId)
    .maybeSingle();
  if (error) throw error;
  return (data as ContactRow) ?? null;
}

async function findByPhone(phoneE164: string): Promise<ContactRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("phone", phoneE164)
    .limit(5);
  if (error) throw error;
  return (data as ContactRow[]) ?? [];
}

async function findByEmail(emailNormalized: string): Promise<ContactRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("email", emailNormalized)
    .limit(5);
  if (error) throw error;
  return (data as ContactRow[]) ?? [];
}

export async function matchContactIdentity(
  input: IdentityMatchInput,
): Promise<IdentityMatchResult> {
  requireTenantContext();
  const country: CountryCode = input.defaultCountry ?? "MX";
  const normalizedPhone = normalizePhone(input.phone ?? null, country);
  const normalizedEmail = normalizeEmail(input.email ?? null);

  // 1. Match por identidad externa directa
  const externalId =
    input.source === "shopify"
      ? input.shopifyCustomerId ?? null
      : input.whaapyContactId ?? null;
  if (externalId) {
    const direct = await findByExternalId(input.source, externalId);
    if (direct) {
      return {
        recommendation: "update_by_external_id",
        match: direct,
        normalizedPhone,
        normalizedEmail,
        hadStrongIdentifiers: !!(normalizedPhone || normalizedEmail),
      };
    }
  }

  // 2. Match por phone
  const phoneMatches: ContactRow[] = normalizedPhone
    ? await findByPhone(normalizedPhone)
    : [];

  if (phoneMatches.length > 1) {
    await recordAuditEvent({
      actorUserId: null,
      eventType: "identity_match_conflict_phone",
      entityType: "contact",
      entityId: null,
      payload: {
        source: input.source,
        phone: normalizedPhone,
        matched_contact_ids: phoneMatches.map((c) => c.id),
      },
    });
    return {
      recommendation: "conflict_create_new",
      match: null,
      normalizedPhone,
      normalizedEmail,
      hadStrongIdentifiers: true,
    };
  }

  const phoneSingleMatch: ContactRow | null = phoneMatches[0] ?? null;
  if (phoneSingleMatch) {
    return {
      recommendation: "link_external_id",
      match: phoneSingleMatch,
      normalizedPhone,
      normalizedEmail,
      hadStrongIdentifiers: true,
    };
  }

  // 3. Match por email
  const emailMatches: ContactRow[] = normalizedEmail
    ? await findByEmail(normalizedEmail)
    : [];

  if (emailMatches.length > 1) {
    await recordAuditEvent({
      actorUserId: null,
      eventType: "identity_match_conflict_email",
      entityType: "contact",
      entityId: null,
      payload: {
        source: input.source,
        email: normalizedEmail,
        matched_contact_ids: emailMatches.map((c) => c.id),
      },
    });
    return {
      recommendation: "conflict_create_new",
      match: null,
      normalizedPhone,
      normalizedEmail,
      hadStrongIdentifiers: true,
    };
  }

  if (emailMatches[0]) {
    return {
      recommendation: "link_external_id",
      match: emailMatches[0],
      normalizedPhone,
      normalizedEmail,
      hadStrongIdentifiers: true,
    };
  }

  // 4. Sin match
  if (!normalizedPhone && !normalizedEmail) {
    await recordAuditEvent({
      actorUserId: null,
      eventType: "contact_without_strong_identifiers",
      entityType: "contact",
      entityId: null,
      payload: {
        source: input.source,
        shopify_customer_id: input.shopifyCustomerId ?? null,
        whaapy_contact_id: input.whaapyContactId ?? null,
      },
    });
  }

  return {
    recommendation: "create_new",
    match: null,
    normalizedPhone,
    normalizedEmail,
    hadStrongIdentifiers: !!(normalizedPhone || normalizedEmail),
  };
}

export type LeadMatchRecommendation =
  | "link_existing"        // contacto existente (lead o cliente) — usarlo, no duplicar
  | "create_new"           // sin match — crear contacto nuevo
  | "conflict_create_new"; // ≥2 contactos con el identificador — ambiguo, crear nuevo + audit

export interface LeadIdentityMatchResult {
  recommendation: LeadMatchRecommendation;
  match: ContactRow | null;
  normalizedPhone: string | null;
  normalizedEmail: string | null;
}

/**
 * Match de identidad para un lead NACIDO EN LA PLATAFORMA (creación
 * manual o por webhook). Camino canónico compartido de creación de leads.
 *
 * A diferencia de `matchContactIdentity`, NO hay tier de identidad externa:
 * un lead de plataforma no carga `shopify_customer_id` ni `whaapy_contact_id`
 * propios. Por eso el merge-collapse de teléfonos (ERRORES.md "Teléfono
 * compartido entre dos customers de Shopify los fusiona…") NO aplica aquí —
 * no hay identidad externa entrante que pisar o perder. Enlazar a un
 * contacto existente (lead O cliente) es el comportamiento CORRECTO por la
 * regla Duplicados de la doctrina ("si el contacto ya existe, se enlaza al
 * existente en vez de crear uno nuevo").
 *
 * Tiers (espejo de phone→email de `matchContactIdentity`):
 *   - phone único → enlazar a ese contacto.
 *   - phone en >1 contacto → conflicto (ambiguo) → crear nuevo + audit.
 *   - sin phone match → email (mismo criterio).
 *   - sin match → crear nuevo.
 */
export async function matchLeadIdentity(input: {
  phone?: string | null;
  email?: string | null;
  defaultCountry?: CountryCode;
}): Promise<LeadIdentityMatchResult> {
  requireTenantContext();
  const country: CountryCode = input.defaultCountry ?? "MX";
  const normalizedPhone = normalizePhone(input.phone ?? null, country);
  const normalizedEmail = normalizeEmail(input.email ?? null);

  if (normalizedPhone) {
    const phoneMatches = await findByPhone(normalizedPhone);
    if (phoneMatches.length > 1) {
      await recordAuditEvent({
        actorUserId: null,
        eventType: "lead_identity_conflict_phone",
        entityType: "contact",
        entityId: null,
        payload: {
          phone: normalizedPhone,
          matched_contact_ids: phoneMatches.map((c) => c.id),
        },
      });
      return { recommendation: "conflict_create_new", match: null, normalizedPhone, normalizedEmail };
    }
    if (phoneMatches[0]) {
      return { recommendation: "link_existing", match: phoneMatches[0], normalizedPhone, normalizedEmail };
    }
  }

  if (normalizedEmail) {
    const emailMatches = await findByEmail(normalizedEmail);
    if (emailMatches.length > 1) {
      await recordAuditEvent({
        actorUserId: null,
        eventType: "lead_identity_conflict_email",
        entityType: "contact",
        entityId: null,
        payload: {
          email: normalizedEmail,
          matched_contact_ids: emailMatches.map((c) => c.id),
        },
      });
      return { recommendation: "conflict_create_new", match: null, normalizedPhone, normalizedEmail };
    }
    if (emailMatches[0]) {
      return { recommendation: "link_existing", match: emailMatches[0], normalizedPhone, normalizedEmail };
    }
  }

  return { recommendation: "create_new", match: null, normalizedPhone, normalizedEmail };
}

/** Helper para listar contactos por phone — útil para botón "Crear contacto en Shopify" (M6). */
export async function findContactsByPhone(
  phoneE164: string,
): Promise<ContactRow[]> {
  return findByPhone(phoneE164);
}

/** Helper de auditoría para registrar un enlace de identidad. */
export async function recordIdentityLink(input: {
  contactId: UUID;
  source: IdentitySource;
  externalId: string;
}): Promise<void> {
  await recordAuditEvent({
    actorUserId: null,
    eventType: `identity_linked_${input.source}`,
    entityType: "contact",
    entityId: input.contactId,
    payload: { external_id: input.externalId },
  });
}
