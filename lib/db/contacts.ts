import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { normalizeEmail, normalizePhone } from "@/lib/services/identity-matching";
import type {
  ContactRow,
  Database,
  ISODateString,
  UUID,
} from "@/lib/types/database";

type Insert = Database["public"]["Tables"]["contacts"]["Insert"];
type Update = Database["public"]["Tables"]["contacts"]["Update"];

/**
 * Contactos (Grupo B). Toda función opera bajo tenant context
 * — el wrapper inyecta `organization_id` automáticamente.
 */

export async function getContactById(id: UUID): Promise<ContactRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function findContactByShopifyCustomerId(
  shopifyCustomerId: string,
): Promise<ContactRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("shopify_customer_id", shopifyCustomerId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function findContactByWhaapyContactId(
  whaapyContactId: string,
): Promise<ContactRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("whaapy_contact_id", whaapyContactId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function findContactByPhoneOrEmail(
  identifiers: { phone?: string | null; email?: string | null },
): Promise<ContactRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const phone = identifiers.phone?.trim() ?? null;
  const email = identifiers.email?.trim().toLowerCase() ?? null;

  if (!phone && !email) return null;

  let query = supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", organizationId);

  // Buscamos por OR — Supabase espera el `or` chain
  const ors: string[] = [];
  if (phone) ors.push(`phone.eq.${phone}`);
  if (email) ors.push(`email.eq.${email}`);
  query = query.or(ors.join(","));

  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function createContact(
  input: Omit<Insert, "organization_id">,
): Promise<ContactRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("contacts")
    .insert({ ...input, organization_id: organizationId })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function updateContact(
  id: UUID,
  patch: Update,
): Promise<ContactRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("contacts")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function listContacts(opts: {
  limit?: number;
  offset?: number;
  assignedAdvisorId?: UUID | null;
} = {}): Promise<ContactRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false });

  if (opts.assignedAdvisorId !== undefined) {
    if (opts.assignedAdvisorId === null) {
      query = query.is("assigned_advisor_id", null);
    } else {
      query = query.eq("assigned_advisor_id", opts.assignedAdvisorId);
    }
  }
  if (opts.limit) query = query.limit(opts.limit);
  if (opts.offset) query = query.range(opts.offset, opts.offset + (opts.limit ?? 100) - 1);

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

// ============================================================
// Listado paginado para la pestaña Contactos (M6 — B2)
// ============================================================

/**
 * Fila del listado de Contactos (M6) — sólo los campos que la lista
 * necesita pintar. `contact_type` se deriva en server desde
 * `shopify_customer_id` para no depender del tipo TS de la columna
 * GENERATED STORED de la migración 0013 (que no está reflejado en
 * `lib/types/database.ts` hand-written; ver lección M3 en CLAUDE.md).
 */
export interface ContactListRow {
  id: UUID;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  shopify_customer_id: string | null;
  whaapy_contact_id: string | null;
  contactType: "lead" | "cliente";
  assigned_advisor_id: UUID | null;
  last_modified_at: ISODateString;
  last_whaapy_activity_at: ISODateString | null;
  missing_phone: boolean;
  deleted_in_shopify: boolean;
  deleted_in_whaapy: boolean;
  anonymized_at: ISODateString | null;
}

export interface SearchContactsOpts {
  /** Texto libre. Vacío/null → sin filtro de búsqueda. */
  query?: string | null;
  /** Vendedor: pasar membershipId. Admin sin filtro: undefined. */
  assignedAdvisorId?: UUID | null;
  /** Filtros adicionales (lote de polish M6). */
  filterAdvisorId?: UUID | null;
  dateFrom?: string;
  dateTo?: string;
  limit: number;
  offset?: number;
}

export interface SearchContactsResult {
  rows: ContactListRow[];
  /** True si hay más allá del page actual (paginación cursor-less). */
  hasMore: boolean;
}

/**
 * Sanitiza un fragmento para construir un `or` chain de PostgREST.
 *
 * PostgREST `.or()` usa coma para separar predicados y punto como
 * delimitador entre operador y valor. Caracteres `,` `.` `(` `)`
 * en el input romperían el parser; los reemplazamos por espacio.
 * También limitamos la longitud para evitar abusos.
 */
function sanitizeOrFragment(raw: string): string {
  return raw
    .replace(/[,.()*%\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * Para el lote de polish M6: dado un set de IDs de contacto, devuelve
 * los asesores derivados de sus oportunidades ACTIVAS.
 *
 * Si todas las opps del contacto apuntan al mismo asesor → derivado.
 * Si hay varios distintos → `conflict = true` (no se elige uno).
 * Si no hay opps activas con asesor → no aparece en el mapa.
 *
 * R2: la asignación de contacto y opp son independientes. Esto es
 * DERIVACIÓN VISUAL, no asignación real. La UI muestra el asesor
 * derivado solo cuando el contacto NO tiene `assigned_advisor_id`
 * explícito — sin sobrescribir nada en BD.
 */
export interface DerivedAdvisor {
  advisorId: UUID | null;
  conflict: boolean;
  sourceCount: number;
}

/**
 * Para el lote polish M6 ronda 2 (bug 3 — filtro asesor incluye
 * heredado): dado un advisor membership_id, devuelve los `contact_id`
 * que (a) tienen `assigned_advisor_id IS NULL` propio Y (b) tienen al
 * menos una oportunidad activa asignada a ese asesor.
 *
 * Estos son los contactos "heredados" — visualmente aparecen con el
 * asesor del opp, así que el filtro debe encontrarlos también.
 *
 * Cap defensivo: 10k IDs (URL/PostgREST `in.()`). Org realista del
 * MVP queda muy por debajo.
 */
export async function getContactIdsWithDerivedAdvisor(
  advisorMembershipId: UUID,
): Promise<UUID[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  // Trae opps activas asignadas a ese advisor, agrupadas por contact_id
  // luego filtra a aquellos contacts que NO tienen advisor propio.
  const { data, error } = await supabase
    .from("opportunities")
    .select("contact_id, contacts!inner(id, assigned_advisor_id)")
    .eq("organization_id", organizationId)
    .eq("assigned_advisor_id", advisorMembershipId)
    .is("cancelled_at", null)
    .is("contacts.assigned_advisor_id", null)
    .limit(10000);
  if (error) throw error;
  const ids = new Set<UUID>();
  for (const row of (data ?? []) as Array<{ contact_id: UUID }>) {
    ids.add(row.contact_id);
  }
  return Array.from(ids);
}

export async function getDerivedAdvisorsForContacts(
  contactIds: UUID[],
): Promise<Map<UUID, DerivedAdvisor>> {
  const out = new Map<UUID, DerivedAdvisor>();
  if (contactIds.length === 0) return out;
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("contact_id, assigned_advisor_id")
    .eq("organization_id", organizationId)
    .in("contact_id", contactIds)
    .is("cancelled_at", null)
    .not("assigned_advisor_id", "is", null);
  if (error) throw error;
  // contact_id → set distinct advisor IDs
  const byContact = new Map<UUID, Set<UUID>>();
  for (const row of (data ?? []) as Array<{
    contact_id: UUID;
    assigned_advisor_id: UUID;
  }>) {
    let set = byContact.get(row.contact_id);
    if (!set) {
      set = new Set();
      byContact.set(row.contact_id, set);
    }
    set.add(row.assigned_advisor_id);
  }
  byContact.forEach((set, contactId) => {
    const advisorList = Array.from(set);
    if (advisorList.length === 1) {
      out.set(contactId, {
        advisorId: advisorList[0] as UUID,
        conflict: false,
        sourceCount: 1,
      });
    } else if (advisorList.length > 1) {
      out.set(contactId, {
        advisorId: null,
        conflict: true,
        sourceCount: advisorList.length,
      });
    }
  });
  return out;
}

/**
 * Listado paginado de contactos con búsqueda multi-campo.
 *
 * Búsqueda:
 *   - `query` se normaliza a E.164 (phone) y lowercase (email) y se
 *     usan tres OR: full_name ilike, email ilike, phone ilike. Si la
 *     normalización del teléfono devuelve E.164 válido, se usa ese
 *     valor para el filtro de phone (más preciso que el texto crudo).
 *   - Vacío → sin filtro de búsqueda, lista por última actividad.
 *
 * Paginación:
 *   - Pide `limit + 1` filas y reporta `hasMore` si recibió al menos
 *     `limit + 1`. Patrón consistente con `listKanbanOpportunities`.
 *
 * Orden:
 *   - `(last_modified_at DESC, id ASC)` para estabilidad ante ties.
 *
 * `deleted_in_*` y `anonymized_at` se devuelven al caller — la UI
 * decide si los renderiza con badge especial (anonimizado) o si los
 * oculta. Por default acá NO filtramos: el admin puede querer ver
 * contactos eliminados externamente para revisión.
 */
export async function searchContactsForList(
  opts: SearchContactsOpts,
): Promise<SearchContactsResult> {
  const { supabase, organizationId } = getTenantScopedClient();
  const limit = opts.limit;
  const offset = opts.offset ?? 0;

  let query = supabase
    .from("contacts")
    .select(
      "id, full_name, email, phone, shopify_customer_id, whaapy_contact_id, " +
      "assigned_advisor_id, last_modified_at, last_whaapy_activity_at, " +
      "missing_phone, deleted_in_shopify, deleted_in_whaapy, anonymized_at",
    )
    .eq("organization_id", organizationId)
    .order("last_modified_at", { ascending: false })
    .order("id", { ascending: true });

  if (opts.assignedAdvisorId !== undefined) {
    if (opts.assignedAdvisorId === null) {
      query = query.is("assigned_advisor_id", null);
    } else {
      query = query.eq("assigned_advisor_id", opts.assignedAdvisorId);
    }
  }
  // Filtros adicionales del lote polish M6 ronda 2. Sólo aplican cuando
  // el caller es admin — la action enforce el role.
  if (opts.filterAdvisorId !== undefined && opts.assignedAdvisorId === undefined) {
    if (opts.filterAdvisorId === null) {
      query = query.is("assigned_advisor_id", null);
    } else {
      // Bug 3: el filtro de asesor debe incluir los heredados — contactos
      // sin assigned_advisor_id propio cuyas opps activas están asignadas
      // a ese asesor. Pre-resolvemos esos contact_ids y los OR-eamos.
      const derivedIds = await getContactIdsWithDerivedAdvisor(opts.filterAdvisorId);
      if (derivedIds.length === 0) {
        query = query.eq("assigned_advisor_id", opts.filterAdvisorId);
      } else {
        const inList = derivedIds.join(",");
        query = query.or(
          `assigned_advisor_id.eq.${opts.filterAdvisorId},id.in.(${inList})`,
        );
      }
    }
  }
  if (opts.dateFrom) query = query.gte("last_modified_at", opts.dateFrom);
  if (opts.dateTo) query = query.lte("last_modified_at", opts.dateTo);

  const raw = (opts.query ?? "").trim();
  if (raw.length > 0) {
    const sanitized = sanitizeOrFragment(raw);
    if (sanitized.length > 0) {
      // E.164 si el input se parsea como teléfono; si no, usar el
      // sanitized para ilike sobre phone (cubre búsquedas parciales
      // tipo "5561168236" sin código de país).
      const phoneE164 = normalizePhone(sanitized);
      const phoneTerm = phoneE164 ?? sanitized;
      const emailTerm = normalizeEmail(sanitized) ?? sanitized;
      const predicates = [
        `full_name.ilike.%${sanitized}%`,
        `email.ilike.%${emailTerm}%`,
        `phone.ilike.%${phoneTerm}%`,
      ];
      query = query.or(predicates.join(","));
    }
  }

  query = query.range(offset, offset + limit);

  const { data, error } = await query;
  if (error) throw error;

  type Selected = Omit<ContactListRow, "contactType">;
  const fetched = (data ?? []) as unknown as Selected[];
  const hasMore = fetched.length > limit;
  const slice = hasMore ? fetched.slice(0, limit) : fetched;

  const rows: ContactListRow[] = slice.map((r) => ({
    ...r,
    contactType: r.shopify_customer_id ? "cliente" : "lead",
  }));
  return { rows, hasMore };
}
