import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import type {
  ContactRow,
  Database,
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
