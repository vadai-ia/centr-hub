"use server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { canSeeAllData, canAccessAdminPanel, type RoleCapabilities } from "@/lib/auth/capabilities";
import { withTenantContext } from "@/lib/tenant/context";
import {
  getContactById,
  updateContact,
  searchContactsForList,
  countContactsForList,
  getDerivedAdvisorsForContacts,
  type ContactListRow,
  type DerivedAdvisor,
} from "@/lib/db/contacts";
import {
  getContactDetail,
  type ContactDetail,
} from "@/lib/db/contacts-detail";
import {
  getContactTimeline,
  type TimelineEvent,
} from "@/lib/services/timeline";
import { reassignOpportunityAdvisor } from "@/lib/services/opportunity-reassignment";
import { propagateContactAdvisorChange } from "@/lib/services/contact-advisor-sync";
import {
  getMembership,
  listActiveRealVendors,
  listMembershipsForOrganization,
} from "@/lib/db/users";
import { getUserProfile } from "@/lib/db/users";
import { getOrganizationById } from "@/lib/db/organizations";
import { recordAuditEvent } from "@/lib/db/operational";
import {
  createCustomer,
  BackfillSuppressedError,
} from "@/lib/shopify/outbound";
import {
  ShopifyApiError,
  extractShopifyErrorMessage,
} from "@/lib/shopify/admin-client";
import { recordWhaapySyncIntent } from "@/lib/inngest/functions/customers";
import {
  getInngestClient,
  SHOPIFY_OUTBOUND_CONTACT_UPDATE_EVENT,
  type ShopifyContactUpdateEnvelope,
} from "@/lib/inngest/client";
import { normalizePhone } from "@/lib/services/identity-matching";
import {
  structuredAddressToJson,
  structuredAddressToShopify,
  zStructuredAddress,
} from "@/lib/contacts/address";
import { CONTACTS_PAGE_SIZE } from "@/lib/constants";
import type {
  ContactRow,
  Json,
  UUID,
} from "@/lib/types/database";

/**
 * Server actions del listado de Contactos (M6 — B2).
 *
 * Patrón espejo de `lib/actions/pipeline.ts`:
 *   - Validación Zod en cada entrada.
 *   - getSession + withTenantContext envuelven la lógica.
 *   - Vendedor solo ve sus asignados — el `assignedAdvisorId` recibido
 *     del cliente se IGNORA si no es admin. Defensa en profundidad
 *     contra que la UI envíe algo distinto.
 */

export interface AdvisorOption {
  membershipId: UUID;
  userId: UUID;
  fullName: string;
  color: string;
}

export interface ContactsBoardState {
  rows: ContactListRow[];
  hasMore: boolean;
  page: number;
  query: string;
  /** Total absoluto de contactos del scope (vendedor: los suyos). */
  totalCount: number;
  /** Total que matchea el filtro/búsqueda activos (= totalCount si no hay). */
  filteredCount: number;
  advisors: AdvisorOption[];
  /** Key del rol del caller (sistema o custom). Para display/hints. */
  role: string;
  /** True si el rol alcanza todos los datos (admin/superadmin/SDR); false
   *  si solo los propios (vendedor). El Client oculta hints de "asignados
   *  a ti" y muestra filtros de todo-el-equipo con esto (0039). */
  canSeeAll: boolean;
  /** Membership del usuario activo (null si ve todo). Usado por la UI
   *  para destacar "tus contactos" en futuras iteraciones. */
  selfMembershipId: UUID | null;
  /** Lote polish M6: asesor derivado por contacto (solo si el contacto
   *  no tiene asesor propio pero sí lo tienen sus opps). */
  derivedAdvisors: Record<UUID, DerivedAdvisor>;
}

export type LoadContactsActionResult =
  | { ok: true; state: ContactsBoardState }
  | { ok: false; reason: string; message: string };

export type SearchContactsActionResult =
  | {
      ok: true;
      rows: ContactListRow[];
      hasMore: boolean;
      page: number;
      totalCount: number;
      filteredCount: number;
      derivedAdvisors: Record<UUID, DerivedAdvisor>;
    }
  | { ok: false; reason: string; message: string };

const searchSchema = z.object({
  query: z.string().max(200).optional(),
  page: z.number().int().nonnegative().default(0),
  /** Lote polish M6: filtros adicionales. */
  filterAdvisorId: z.string().uuid().nullable().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  /** Fix A: incluir contactos archivados por borrado en Whaapy. */
  includeArchived: z.boolean().optional(),
});

async function resolveEffectiveAdvisor(
  orgId: UUID,
  userId: UUID,
  caps: RoleCapabilities,
): Promise<{ effectiveAdvisorId: UUID | null | undefined; membership: UUID | null }> {
  if (canSeeAllData(caps)) {
    return { effectiveAdvisorId: undefined, membership: null };
  }
  const membership = await getMembership(userId, orgId);
  if (!membership) {
    return { effectiveAdvisorId: undefined, membership: null };
  }
  return { effectiveAdvisorId: membership.id, membership: membership.id };
}

/**
 * Snapshot inicial del listado para el primer render del Server
 * Component. Carga: advisors + primera page.
 */
export async function loadInitialContactsState(opts: {
  query?: string;
}): Promise<LoadContactsActionResult> {
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, reason: "no_session", message: "Sesión expirada." };
  }
  const orgId = session.data.activeOrg.id;
  const role = session.data.activeOrg.role;
  const caps = session.data.activeRole;
  const userId = session.data.userId;

  return withTenantContext(orgId, async () => {
    const { effectiveAdvisorId, membership } = await resolveEffectiveAdvisor(
      orgId,
      userId,
      caps,
    );
    if (!canSeeAllData(caps) && !membership) {
      return {
        ok: false,
        reason: "no_membership",
        message: "No tienes acceso a esta organización.",
      };
    }

    const hasQuery = (opts.query ?? "").trim().length > 0;
    const [{ rows, hasMore }, totalCount, filteredCount, vendors] = await Promise.all([
      searchContactsForList({
        query: opts.query ?? "",
        assignedAdvisorId: effectiveAdvisorId,
        limit: CONTACTS_PAGE_SIZE,
        offset: 0,
      }),
      // Total absoluto del scope (sin búsqueda ni filtros).
      countContactsForList({ assignedAdvisorId: effectiveAdvisorId, includeArchived: false }),
      // Total filtrado (= absoluto si no hay búsqueda en el snapshot inicial).
      hasQuery
        ? countContactsForList({
            query: opts.query ?? "",
            assignedAdvisorId: effectiveAdvisorId,
            includeArchived: false,
          })
        : Promise.resolve<number | null>(null),
      listActiveRealVendors(orgId),
    ]);

    // Asesores derivados sólo para contactos sin asignación explícita.
    const unassignedIds = rows.filter((r) => r.assigned_advisor_id === null).map((r) => r.id);
    const derivedMap = await getDerivedAdvisorsForContacts(unassignedIds);
    const derivedAdvisors: Record<UUID, DerivedAdvisor> = {};
    derivedMap.forEach((v, k) => { derivedAdvisors[k] = v; });

    return {
      ok: true,
      state: {
        rows,
        hasMore,
        page: 0,
        query: opts.query ?? "",
        totalCount,
        filteredCount: filteredCount ?? totalCount,
        role,
        canSeeAll: canSeeAllData(caps),
        selfMembershipId: membership,
        derivedAdvisors,
        advisors: vendors.map((v) => ({
          membershipId: v.id,
          userId: v.user_id,
          fullName: v.profile.full_name,
          color: v.profile.color,
        })),
      },
    };
  }, { source: "user_session" });
}

/**
 * Server Action invocada por el Client al cambiar el query o al
 * cargar más páginas. NO recarga la lista de advisors (ya está en
 * el estado del Client).
 */
export async function searchContactsAction(
  raw: unknown,
): Promise<SearchContactsActionResult> {
  const parsed = searchSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_input",
      message: "Parámetros de búsqueda inválidos.",
    };
  }

  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, reason: "no_session", message: "Sesión expirada." };
  }
  const orgId = session.data.activeOrg.id;
  const caps = session.data.activeRole;
  const userId = session.data.userId;

  return withTenantContext(orgId, async () => {
    const { effectiveAdvisorId, membership } = await resolveEffectiveAdvisor(
      orgId,
      userId,
      caps,
    );
    const isAdmin = canSeeAllData(caps);
    if (!isAdmin && !membership) {
      return {
        ok: false,
        reason: "no_membership",
        message: "No tienes acceso a esta organización.",
      };
    }

    const filterAdvisorId = isAdmin ? parsed.data.filterAdvisorId ?? undefined : undefined;
    const includeArchived = parsed.data.includeArchived ?? false;
    const listOpts = {
      query: parsed.data.query ?? "",
      assignedAdvisorId: effectiveAdvisorId,
      // Admin puede filtrar por asesor adicionalmente (lote polish M6).
      filterAdvisorId,
      dateFrom: parsed.data.dateFrom,
      dateTo: parsed.data.dateTo,
      includeArchived,
    };
    // ¿La vista está "acotada" (búsqueda/fecha/asesor)? El toggle de
    // archivados NO cuenta como acotar — reajusta el scope base.
    const narrowed =
      (parsed.data.query ?? "").trim().length > 0 ||
      !!parsed.data.dateFrom ||
      !!parsed.data.dateTo ||
      filterAdvisorId != null;

    const [{ rows, hasMore }, totalCount, filteredCountRaw] = await Promise.all([
      searchContactsForList({
        ...listOpts,
        limit: CONTACTS_PAGE_SIZE,
        offset: parsed.data.page * CONTACTS_PAGE_SIZE,
      }),
      // Total absoluto del scope base (respeta archivados + scope de vendedor).
      countContactsForList({ assignedAdvisorId: effectiveAdvisorId, includeArchived }),
      narrowed ? countContactsForList(listOpts) : Promise.resolve<number | null>(null),
    ]);
    const filteredCount = filteredCountRaw ?? totalCount;

    const unassignedIds = rows.filter((r) => r.assigned_advisor_id === null).map((r) => r.id);
    const derivedMap = await getDerivedAdvisorsForContacts(unassignedIds);
    const derivedAdvisors: Record<UUID, DerivedAdvisor> = {};
    derivedMap.forEach((v, k) => { derivedAdvisors[k] = v; });

    return { ok: true, rows, hasMore, page: parsed.data.page, totalCount, filteredCount, derivedAdvisors };
  }, { source: "user_session" });
}

// ============================================================
// Detalle de contacto (M6 — B3)
// ============================================================

export interface ContactDetailBundle {
  detail: ContactDetail;
  timeline: TimelineEvent[];
  advisors: AdvisorOption[];
  role: string;
  /** True si el rol alcanza todos los datos (admin/superadmin/SDR). */
  canSeeAll: boolean;
  selfMembershipId: UUID | null;
  /** True si el caller tiene permiso de edición. Vendedor: solo si
   *  asignado al contacto. Admin: siempre. */
  canEdit: boolean;
  /** True si el caller puede ver el botón "Reasignar asesor". */
  canReassign: boolean;
  /** True si el caller puede meter el contacto a Outbound (admin/SDR). */
  canManageOutbound: boolean;
  /** True si el caller puede QUITAR la marca outbound (corrección admin). */
  canUnsetOutbound: boolean;
}

export type LoadContactDetailResult =
  | { ok: true; bundle: ContactDetailBundle }
  | { ok: false; reason: "not_found" | "forbidden" | "no_session" | "no_membership"; message: string };

/**
 * Carga el detalle consolidado de un contacto + timeline + advisors.
 *
 * Reglas de acceso:
 *   - Admin/superadmin: acceso total.
 *   - Vendedor: solo si `contact.assigned_advisor_id === his.membership.id`.
 *   - Vendedor sin membership activa: forbidden.
 *
 * Si el contact no existe o no pertenece a la org activa,
 * retorna `not_found` (RLS extra-defensa).
 */
export async function loadContactDetail(opts: {
  contactId: UUID;
}): Promise<LoadContactDetailResult> {
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, reason: "no_session", message: "Sesión expirada." };
  }
  const orgId = session.data.activeOrg.id;
  const role = session.data.activeOrg.role;
  const userId = session.data.userId;
  const isAdmin = canSeeAllData(session.data.activeRole);

  return withTenantContext(orgId, async () => {
    const membership = await getMembership(userId, orgId);
    if (!isAdmin && !membership) {
      return {
        ok: false,
        reason: "no_membership",
        message: "No tienes acceso a esta organización.",
      } as const;
    }

    const detail = await getContactDetail(opts.contactId);
    if (!detail) {
      return {
        ok: false,
        reason: "not_found",
        message: "Este contacto no existe o no tienes acceso.",
      } as const;
    }

    // Guard de asignación para vendedores. Devolvemos `not_found`
    // (no `forbidden`) para no distinguir "no existe" vs "sin acceso",
    // evitando filtración de IDs válidos. Audit del intento queda
    // registrado para detectar uso indebido.
    if (!isAdmin) {
      const assignedToSelf =
        detail.contact.assigned_advisor_id === membership?.id;
      if (!assignedToSelf) {
        try {
          await recordAuditEvent({
            actorUserId: userId,
            eventType: "contact_access_forbidden",
            entityType: "contact",
            entityId: opts.contactId,
            payload: { reason: "not_assigned" },
          });
        } catch {
          // ignore
        }
        return {
          ok: false,
          reason: "not_found",
          message: "Este contacto no existe o no tienes acceso.",
        } as const;
      }
    }

    const [timeline, vendors] = await Promise.all([
      getContactTimeline(opts.contactId),
      listActiveRealVendors(orgId),
    ]);

    return {
      ok: true,
      bundle: {
        detail,
        timeline,
        role,
        canSeeAll: isAdmin,
        selfMembershipId: membership?.id ?? null,
        canEdit: isAdmin || detail.contact.assigned_advisor_id === membership?.id,
        canReassign: isAdmin,
        canManageOutbound: isAdmin, // canSeeAll (admin/SDR)
        canUnsetOutbound: canAccessAdminPanel(session.data.activeRole),
        advisors: vendors.map((v) => ({
          membershipId: v.id,
          userId: v.user_id,
          fullName: v.profile.full_name,
          color: v.profile.color,
        })),
      },
    } as const;
  }, { source: "user_session" });
}

// ============================================================
// Crear contacto en Shopify (M6 — B6) — asimetría v5.1
// ============================================================

const createInShopifySchema = z.object({
  contactId: z.string().uuid(),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().max(100).optional(),
  email: z.string().email().max(200).optional().or(z.literal("")),
  phone: z.string().min(4).max(40),
  /** Dirección estructurada (10 campos Shopify). Ninguno obligatorio. */
  address: zStructuredAddress.optional(),
});

export type CreateInShopifyResult =
  | {
      ok: true;
      shopifyCustomerId: string;
      alreadyExisted: boolean;
      message: string;
    }
  | {
      ok: false;
      reason:
        | "no_session"
        | "no_membership"
        | "forbidden"
        | "invalid_input"
        | "contact_not_found"
        | "phone_invalid"
        | "already_linked"
        | "shop_domain_missing"
        | "backfill_suppressed"
        | "shopify_api_error"
        | "internal_error";
      message: string;
    };

/**
 * Crea el customer del contacto en Shopify (asimetría v5.1).
 *
 * Reglas (CLAUDE.md "Botón Crear contacto en Shopify"):
 *   - Solo admin o el vendedor asignado al contacto pueden invocar.
 *   - El contacto debe ser LEAD (sin shopify_customer_id ya enlazado).
 *   - Phone es required y se normaliza a E.164 (default MX) antes de
 *     enviar a Shopify; si no es válido → error claro al usuario.
 *   - El match defensivo por teléfono vive DENTRO de createCustomer
 *     ([lib/shopify/outbound.ts]) y reporta `alreadyExisted=true` si
 *     Shopify ya tenía un customer con ese teléfono → enlaza sin
 *     duplicar y la UI muestra mensaje específico.
 *   - El audit y la persistencia de `shopify_customer_id` viven dentro
 *     de createCustomer; aquí solo coordinamos la sesión y validación.
 */
export async function createContactInShopifyAction(
  raw: unknown,
): Promise<CreateInShopifyResult> {
  const parsed = createInShopifySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_input",
      message: "Datos inválidos: revisa nombre, email y teléfono.",
    };
  }

  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, reason: "no_session", message: "Sesión expirada." };
  }
  const orgId = session.data.activeOrg.id;
  const userId = session.data.userId;
  const isAdmin = canSeeAllData(session.data.activeRole);

  return withTenantContext(orgId, async () => {
    const membership = await getMembership(userId, orgId);
    if (!isAdmin && !membership) {
      return {
        ok: false,
        reason: "no_membership",
        message: "No tienes acceso a esta organización.",
      };
    }

    const contact = await getContactById(parsed.data.contactId);
    if (!contact) {
      return {
        ok: false,
        reason: "contact_not_found",
        message: "El contacto ya no existe.",
      };
    }

    if (!isAdmin && contact.assigned_advisor_id !== membership?.id) {
      return {
        ok: false,
        reason: "forbidden",
        message: "No tienes acceso a este contacto.",
      };
    }

    if (contact.shopify_customer_id) {
      return {
        ok: false,
        reason: "already_linked",
        message: "Este contacto ya tiene customer en Shopify.",
      };
    }

    const phoneE164 = normalizePhone(parsed.data.phone);
    if (!phoneE164) {
      return {
        ok: false,
        reason: "phone_invalid",
        message:
          "El teléfono no es válido. Usa formato internacional (ej. +52 55 1234 5678).",
      };
    }

    const org = await getOrganizationById(orgId);
    const shopDomain = org?.shopify_store_domain;
    if (!shopDomain) {
      return {
        ok: false,
        reason: "shop_domain_missing",
        message:
          "Falta configurar el dominio de Shopify en la organización. Contacta al admin.",
      };
    }

    const trimmedEmail = (parsed.data.email ?? "").trim();

    // Persiste la dirección estructurada en el maestro ANTES de invocar a
    // Shopify, de modo que sobreviva aunque Shopify rechace la creación
    // (decisión de negocio: no perder lo que el usuario escribió). Forma
    // canónica legible (con acentos) — la normalización a códigos Shopify
    // ocurre solo en el payload saliente. Borrado intencional propagado:
    // si el usuario dejó la dirección vacía, null sobreescribe (R3).
    if (parsed.data.address !== undefined) {
      const newAddressJson = structuredAddressToJson(parsed.data.address);
      if (!sameJson(newAddressJson, contact.address)) {
        try {
          await updateContact(contact.id, {
            address: newAddressJson,
            last_modified_at: new Date().toISOString(),
            last_modified_source: "platform",
          });
        } catch {
          // No bloquea la creación en Shopify por un fallo al persistir el
          // espejo local; el flujo principal (crear customer) continúa.
        }
      }
    }

    // Mapea la dirección estructurada a UN Shopify Address (país/estado se
    // normalizan a country_code/province_code adentro). Sin dirección →
    // sin addresses.
    const shopifyAddress = parsed.data.address
      ? structuredAddressToShopify(parsed.data.address, phoneE164)
      : null;
    const addresses = shopifyAddress ? [shopifyAddress] : undefined;

    try {
      const result = await createCustomer({
        ctx: { organizationId: orgId, shopDomain },
        contactId: parsed.data.contactId,
        fields: {
          first_name: parsed.data.firstName ?? null,
          last_name: parsed.data.lastName ?? null,
          email: trimmedEmail ? trimmedEmail : null,
          phone: phoneE164,
          addresses,
          note: null,
          tags: null,
        },
      });
      return {
        ok: true,
        shopifyCustomerId: result.shopifyCustomerId,
        alreadyExisted: result.alreadyExisted,
        message: result.alreadyExisted
          ? "El customer ya existía en Shopify; se vinculó al contacto."
          : "Customer creado en Shopify y enlazado al contacto.",
      };
    } catch (e) {
      if (e instanceof BackfillSuppressedError) {
        return {
          ok: false,
          reason: "backfill_suppressed",
          message: "El backfill está en curso. Intenta cuando finalice.",
        };
      }
      if (e instanceof ShopifyApiError) {
        const detail = extractShopifyErrorMessage(e.body);
        return {
          ok: false,
          reason: "shopify_api_error",
          message: detail
            ? `Shopify rechazó la creación (HTTP ${e.status}): ${detail}`
            : `Shopify rechazó la creación (HTTP ${e.status}). Revisa los datos o intenta más tarde.`,
        };
      }
      const msg = e instanceof Error ? e.message : "Error desconocido";
      return {
        ok: false,
        reason: "internal_error",
        message: `No se pudo crear el customer: ${msg}`,
      };
    }
  }, { source: "user_session" });
}

// ============================================================
// Reasignación admin (M6 — B7)
// ============================================================

const reassignSchema = z.object({
  entityType: z.enum(["contact", "opportunity"]),
  entityId: z.string().uuid(),
  /** null para "Sin asignar"; UUID para reasignar a un vendedor. */
  newMembershipId: z.string().uuid().nullable(),
});

export type ReassignResult =
  | { ok: true; entityType: "contact" | "opportunity"; entityId: UUID }
  | {
      ok: false;
      reason:
        | "no_session"
        | "forbidden"
        | "invalid_input"
        | "membership_not_found"
        | "membership_inactive"
        | "membership_system_user"
        | "entity_not_found"
        | "internal_error";
      message: string;
    };

/**
 * Reasigna el asesor de un contacto u oportunidad (solo admin).
 *
 * Reglas (CLAUDE.md + R10):
 *   - El nuevo membership (si no es null) debe ser is_active=true y
 *     pertenecer a un user_profile con is_system_user=false. El
 *     dropdown del modal ya filtra; esto es defense-in-depth contra
 *     manipulación del payload.
 *   - Es atómica de cara al cliente: UPDATE + audit_log con
 *     compensating revert si el audit falla (patrón M5).
 *
 * Propagación (post-commit, best-effort):
 *   - Si entity = contact + tiene shopify_customer_id + hay tag
 *     mapping de vendedor para el nuevo/viejo membership: invoca
 *     `updateCustomerTags` directo. Si falla, audit + sigue (el
 *     cambio local quedó; el admin puede reintentar).
 *   - Si entity = contact + tiene whaapy_contact_id: emite el
 *     evento `WHAAPY_OUTBOUND_CONTACT_SYNC_EVENT` con reason
 *     `update_from_platform_ui` para que M4 propague el
 *     `assigned_agent_id` con retry/DLQ.
 *   - Para entity = opportunity, NO propaga (la asignación es por
 *     opp y no afecta a Shopify ni a Whaapy directamente — quedaría
 *     en M7+ si Centr lo pide).
 */
export async function reassignAdvisorAction(
  raw: unknown,
): Promise<ReassignResult> {
  const parsed = reassignSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_input",
      message: "Parámetros de reasignación inválidos.",
    };
  }

  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, reason: "no_session", message: "Sesión expirada." };
  }
  const orgId = session.data.activeOrg.id;
  const userId = session.data.userId;
  const isAdmin = canSeeAllData(session.data.activeRole);

  if (!isAdmin) {
    return {
      ok: false,
      reason: "forbidden",
      message: "Solo administradores pueden reasignar asesores.",
    };
  }

  return withTenantContext(orgId, async () => {
    // Validar el membership destino si no es null.
    if (parsed.data.newMembershipId !== null) {
      const memberships = await listMembershipsForOrganization(orgId);
      const target = memberships.find((m) => m.id === parsed.data.newMembershipId);
      if (!target) {
        return {
          ok: false,
          reason: "membership_not_found",
          message: "El asesor seleccionado no existe en la organización.",
        };
      }
      if (!target.is_active) {
        return {
          ok: false,
          reason: "membership_inactive",
          message:
            "No se puede asignar al asesor: su acceso fue desactivado.",
        };
      }
      const profile = await getUserProfile(target.user_id);
      if (profile?.is_system_user) {
        return {
          ok: false,
          reason: "membership_system_user",
          message:
            "El usuario sistema 'Histórico' no puede recibir asignaciones manuales (R10).",
        };
      }
    }

    if (parsed.data.entityType === "contact") {
      return reassignContact(parsed.data.entityId, parsed.data.newMembershipId, userId);
    }
    return reassignOpportunity(parsed.data.entityId, parsed.data.newMembershipId, userId);
  }, { source: "user_session" });
}

async function reassignContact(
  contactId: UUID,
  newMembershipId: UUID | null,
  actorUserId: UUID,
): Promise<ReassignResult> {
  const contact = await getContactById(contactId);
  if (!contact) {
    return {
      ok: false,
      reason: "entity_not_found",
      message: "El contacto ya no existe.",
    };
  }
  const previousMembershipId = contact.assigned_advisor_id;
  if (previousMembershipId === newMembershipId) {
    return { ok: true, entityType: "contact", entityId: contactId };
  }

  // Snapshot para revert.
  const snapshot = { ...contact };
  const nowIso = new Date().toISOString();

  let updated: ContactRow;
  try {
    updated = await updateContact(contactId, {
      assigned_advisor_id: newMembershipId,
      last_modified_at: nowIso,
      last_modified_source: "platform",
    });
  } catch (e) {
    return {
      ok: false,
      reason: "internal_error",
      message:
        e instanceof Error ? e.message : "No se pudo actualizar el contacto.",
    };
  }

  // Audit principal — si falla, revertimos.
  try {
    await recordAuditEvent({
      actorUserId,
      eventType: "contact_reassigned",
      entityType: "contact",
      entityId: contactId,
      payload: {
        from_membership_id: previousMembershipId,
        to_membership_id: newMembershipId,
      },
    });
  } catch {
    await revertContactAdvisor(contactId, snapshot);
    return {
      ok: false,
      reason: "internal_error",
      message:
        "No se pudo registrar el cambio en auditoría. La reasignación se revirtió.",
    };
  }

  // Propagación post-commit, best-effort. Cualquier falla se audita
  // sin afectar la transacción principal (el cambio local quedó). Reusa el
  // helper compartido con la sincronización dueño-desde-opp (Venta).
  void propagateContactAdvisorChange(updated, previousMembershipId);

  return { ok: true, entityType: "contact", entityId: contactId };
}

async function revertContactAdvisor(
  contactId: UUID,
  snapshot: ContactRow,
): Promise<void> {
  try {
    await updateContact(contactId, {
      assigned_advisor_id: snapshot.assigned_advisor_id,
      last_modified_at: snapshot.last_modified_at,
      last_modified_source: snapshot.last_modified_source,
    });
  } catch {
    // Best-effort — si la reversa falla, el cliente verá error y
    // refrescará. Mismo trade-off que M5 (pipeline-move).
  }
}

async function reassignOpportunity(
  opportunityId: UUID,
  newMembershipId: UUID | null,
  actorUserId: UUID,
): Promise<ReassignResult> {
  // Delega en el núcleo compartido (M9.2) que garantiza el contrato
  // "marcado como manual" (audit `opportunity_reassigned` con actor),
  // de modo que los hooks automáticos no pisen la reasignación.
  const res = await reassignOpportunityAdvisor({
    opportunityId,
    newMembershipId,
    actorUserId,
  });
  if (!res.ok) {
    return { ok: false, reason: res.reason, message: res.message };
  }
  return { ok: true, entityType: "opportunity", entityId: opportunityId };
}

// ============================================================
// Edición de contacto con propagación (M6 — B8)
// ============================================================

/**
 * Schema del form de edición. Email vacío y address vacío se aceptan
 * y se traducen a `null` (borrado intencional propagado — R3).
 */
const editContactSchema = z.object({
  contactId: z.string().uuid(),
  fullName: z.string().max(200).optional(),
  email: z.string().email().max(200).optional().or(z.literal("")),
  phone: z.string().max(40).optional().or(z.literal("")),
  /**
   * Dirección estructurada (10 campos Shopify). El maestro guarda jsonb
   * canónico; vacío en todos los campos → null (borrado propagado, R3).
   */
  address: zStructuredAddress.optional(),
  internalNote: z.string().max(5000).optional().or(z.literal("")),
});

export type EditContactResult =
  | {
      ok: true;
      contactId: UUID;
      missingPhoneCleared: boolean;
      propagatedToShopify: boolean;
      propagatedToWhaapy: boolean;
      propagationDispatchFailed: boolean;
    }
  | {
      ok: false;
      reason:
        | "no_session"
        | "no_membership"
        | "forbidden"
        | "invalid_input"
        | "contact_not_found"
        | "phone_invalid"
        | "internal_error";
      message: string;
    };

/**
 * Edición del contacto + propagación background (M6 — B8).
 *
 * Modelo (Ajuste post-Discovery 2 #14 + CLAUDE.md "Edición de
 * contacto — propagación"):
 *   1. Persiste el maestro INMEDIATAMENTE (atómico con audit).
 *   2. Marca `last_modified_source = 'platform'` + `last_modified_at = now`
 *      para que R11 descarte el eco subsiguiente de Shopify.
 *   3. `missing_phone`: si estaba en true y el phone nuevo es válido,
 *      desmarca el flag y dispara creación en Whaapy si no hay
 *      `whaapy_contact_id` todavía.
 *   4. Propaga a Shopify (background, si shopify_customer_id) emitiendo
 *      evento Inngest. Worker `shopifyOutboundContactUpdate` con retry/DLQ.
 *   5. Propaga a Whaapy (background, si whaapy_contact_id) emitiendo
 *      `recordWhaapySyncIntent(contact, "update_from_platform_ui")`.
 *
 * La UI NO se bloquea: toast inmediato; los workers reintentan.
 */
export async function updateContactWithPropagationAction(
  raw: unknown,
): Promise<EditContactResult> {
  const parsed = editContactSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_input",
      message: "Datos inválidos. Revisa los campos del formulario.",
    };
  }

  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, reason: "no_session", message: "Sesión expirada." };
  }
  const orgId = session.data.activeOrg.id;
  const userId = session.data.userId;
  const isAdmin = canSeeAllData(session.data.activeRole);

  return withTenantContext(orgId, async () => {
    const membership = await getMembership(userId, orgId);
    if (!isAdmin && !membership) {
      return {
        ok: false,
        reason: "no_membership",
        message: "No tienes acceso a esta organización.",
      };
    }

    const existing = await getContactById(parsed.data.contactId);
    if (!existing) {
      return {
        ok: false,
        reason: "contact_not_found",
        message: "El contacto ya no existe.",
      };
    }
    if (!isAdmin && existing.assigned_advisor_id !== membership?.id) {
      return {
        ok: false,
        reason: "forbidden",
        message: "No tienes acceso a este contacto.",
      };
    }

    const newFullName = normalizeEditableString(parsed.data.fullName);
    const newEmail = normalizeEditableEmail(parsed.data.email);
    const newPhoneRaw = normalizeEditableString(parsed.data.phone);
    const newPhone = newPhoneRaw === null ? null : normalizePhone(newPhoneRaw);
    if (newPhoneRaw !== null && newPhone === null) {
      return {
        ok: false,
        reason: "phone_invalid",
        message:
          "El teléfono no es válido. Usa formato internacional (ej. +52 55 1234 5678) o déjalo vacío.",
      };
    }
    // address undefined → el form no lo envió, preserva el existente.
    // Si lo envió, se persiste la forma canónica (o null si todo vacío).
    const newAddress =
      parsed.data.address === undefined
        ? existing.address
        : structuredAddressToJson(parsed.data.address);
    const newInternalNote = normalizeEditableString(parsed.data.internalNote);

    const patch: Partial<ContactRow> = {};
    const changedFields: string[] = [];
    if (newFullName !== existing.full_name) {
      patch.full_name = newFullName;
      changedFields.push("full_name");
    }
    if (newEmail !== existing.email) {
      patch.email = newEmail;
      changedFields.push("email");
    }
    if (newPhone !== existing.phone) {
      patch.phone = newPhone;
      changedFields.push("phone");
    }
    if (!sameJson(newAddress, existing.address)) {
      patch.address = newAddress;
      changedFields.push("address");
    }
    if (newInternalNote !== existing.internal_note) {
      patch.internal_note = newInternalNote;
      changedFields.push("internal_note");
    }

    let missingPhoneCleared = false;
    if (existing.missing_phone && newPhone !== null) {
      patch.missing_phone = false;
      missingPhoneCleared = true;
      changedFields.push("missing_phone");
    }
    if (!existing.missing_phone && newPhone === null) {
      patch.missing_phone = true;
      changedFields.push("missing_phone");
    }

    if (changedFields.length === 0) {
      return {
        ok: true,
        contactId: existing.id,
        missingPhoneCleared: false,
        propagatedToShopify: false,
        propagatedToWhaapy: false,
        propagationDispatchFailed: false,
      };
    }

    const nowIso = new Date().toISOString();
    patch.last_modified_at = nowIso;
    patch.last_modified_source = "platform";

    let updated: ContactRow;
    try {
      updated = await updateContact(existing.id, patch);
    } catch (e) {
      return {
        ok: false,
        reason: "internal_error",
        message:
          e instanceof Error ? e.message : "No se pudo guardar el contacto.",
      };
    }

    try {
      await recordAuditEvent({
        actorUserId: userId,
        eventType: "contact_edited_manually",
        entityType: "contact",
        entityId: existing.id,
        payload: {
          fields: changedFields,
          missing_phone_cleared: missingPhoneCleared,
        },
      });
    } catch {
      // Audit failure no se compensa — el cambio local quedó y el
      // valor operativo del audit es informativo, no transaccional
      // (a diferencia del move de M5).
    }

    let propagatedToShopify = false;
    let propagatedToWhaapy = false;
    let dispatchFailed = false;

    if (updated.shopify_customer_id) {
      const envelope: ShopifyContactUpdateEnvelope = {
        organizationId: updated.organization_id,
        contactId: updated.id,
        reason: "update_from_platform_ui",
        contactSnapshot: {
          shopifyCustomerId: updated.shopify_customer_id,
          fullName: updated.full_name,
          email: updated.email,
          phone: updated.phone,
          address: updated.address,
          internalNote: updated.internal_note,
        },
      };
      try {
        await getInngestClient().send({
          name: SHOPIFY_OUTBOUND_CONTACT_UPDATE_EVENT,
          data: envelope,
        });
        propagatedToShopify = true;
      } catch (e) {
        dispatchFailed = true;
        try {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "shopify_outbound_dispatch_failed",
            entityType: "contact",
            entityId: updated.id,
            payload: { error: e instanceof Error ? e.message : "unknown" },
          });
        } catch {
          // ignore
        }
      }
    }

    const whaapyShouldDispatch =
      updated.whaapy_contact_id !== null ||
      (missingPhoneCleared && updated.phone !== null);
    if (whaapyShouldDispatch) {
      const reason: "update_from_platform_ui" | "create_from_shopify" =
        updated.whaapy_contact_id ? "update_from_platform_ui" : "create_from_shopify";
      try {
        await recordWhaapySyncIntent(updated, reason);
        propagatedToWhaapy = true;
      } catch (e) {
        dispatchFailed = true;
        try {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "whaapy_outbound_dispatch_failed",
            entityType: "contact",
            entityId: updated.id,
            payload: { error: e instanceof Error ? e.message : "unknown" },
          });
        } catch {
          // ignore
        }
      }
    }

    return {
      ok: true,
      contactId: updated.id,
      missingPhoneCleared,
      propagatedToShopify,
      propagatedToWhaapy,
      propagationDispatchFailed: dispatchFailed,
    };
  }, { source: "user_session" });
}

function normalizeEditableString(v: string | undefined): string | null {
  if (v === undefined) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEditableEmail(v: string | undefined): string | null {
  const trimmed = normalizeEditableString(v);
  if (trimmed === null) return null;
  return trimmed.toLowerCase();
}

function sameJson(a: Json | null, b: Json | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}
