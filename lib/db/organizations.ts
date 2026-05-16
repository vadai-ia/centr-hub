import "server-only";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type {
  OrganizationRow,
  Database,
  UUID,
} from "@/lib/types/database";

type Insert = Database["public"]["Tables"]["organizations"]["Insert"];
type Update = Database["public"]["Tables"]["organizations"]["Update"];

/**
 * Organizations CRUD. Excepción al patrón: `bootstrapOrganization`
 * NO requiere contexto previo — es justamente la operación que
 * CREA la organización. Las demás (lecturas/updates) sí pueden
 * usar el wrapper.
 */

export async function getOrganizationById(
  id: UUID,
): Promise<OrganizationRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function getOrganizationBySlug(
  slug: string,
): Promise<OrganizationRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function getOrganizationByShopifyDomain(
  domain: string,
): Promise<OrganizationRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("*")
    .eq("shopify_store_domain", domain)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function updateOrganization(
  id: UUID,
  patch: Update,
): Promise<OrganizationRow> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("organizations")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function createOrganization(input: Insert): Promise<OrganizationRow> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("organizations")
    .insert(input)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/**
 * Llama a la función SQL `public.bootstrap_organization` que crea
 * la org con TODOS sus seeds (etapas, motivos, reglas, usuario
 * sistema "Histórico"). Es la vía oficial para crear una nueva org.
 */
export async function bootstrapOrganization(input: {
  name: string;
  slug: string;
  shopifyStoreUrl?: string | null;
  shopifyStoreDomain?: string | null;
  whaapyBusinessId?: string | null;
}): Promise<UUID> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.rpc("bootstrap_organization", {
    p_name: input.name,
    p_slug: input.slug,
    p_shopify_store_url: input.shopifyStoreUrl ?? null,
    p_shopify_domain: input.shopifyStoreDomain ?? null,
    p_whaapy_business: input.whaapyBusinessId ?? null,
  });
  if (error) throw error;
  if (!data) throw new Error("bootstrap_organization no devolvió id");
  return data as UUID;
}
