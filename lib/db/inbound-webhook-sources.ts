import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { InboundWebhookSourceRow, UUID } from "@/lib/types/database";

/**
 * Fuentes externas de leads por webhook (0038, Bloque B).
 *
 * Dos superficies:
 *   - CRUD tenant-scoped para la pantalla Admin (crear/listar/revocar/rotar).
 *   - Resolutor por slug para el ENDPOINT público, que corre en el borde
 *     ANTES de resolver el tenant → usa el cliente admin directo (como
 *     `getOrganizationByShopifyDomain`), filtrando por el slug globalmente
 *     único. Devuelve la org para instalar `withTenantContext`.
 */

// ------------------------------------------------------------
// CRUD tenant-scoped (Admin)
// ------------------------------------------------------------

export async function listInboundWebhookSources(): Promise<InboundWebhookSourceRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("inbound_webhook_sources")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as InboundWebhookSourceRow[];
}

export async function getInboundWebhookSourceById(
  id: UUID,
): Promise<InboundWebhookSourceRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("inbound_webhook_sources")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return (data as InboundWebhookSourceRow) ?? null;
}

export async function createInboundWebhookSource(input: {
  name: string;
  slug: string;
  tokenHash: string;
  tokenLast4: string;
  createdByUserId: UUID | null;
}): Promise<InboundWebhookSourceRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("inbound_webhook_sources")
    .insert({
      organization_id: organizationId,
      name: input.name,
      slug: input.slug,
      token_hash: input.tokenHash,
      token_last4: input.tokenLast4,
      is_active: true,
      created_by_user_id: input.createdByUserId,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as InboundWebhookSourceRow;
}

export async function setInboundWebhookSourceActive(
  id: UUID,
  isActive: boolean,
): Promise<InboundWebhookSourceRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("inbound_webhook_sources")
    .update({ is_active: isActive })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();
  if (error) throw error;
  return data as InboundWebhookSourceRow;
}

export async function rotateInboundWebhookSourceToken(
  id: UUID,
  tokenHash: string,
  tokenLast4: string,
  rotatedAtIso: string,
): Promise<InboundWebhookSourceRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("inbound_webhook_sources")
    .update({ token_hash: tokenHash, token_last4: tokenLast4, rotated_at: rotatedAtIso })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("*")
    .single();
  if (error) throw error;
  return data as InboundWebhookSourceRow;
}

/** Marca `last_used_at` (best-effort desde el worker, ya en tenant context). */
export async function touchInboundWebhookSourceUsed(
  id: UUID,
  usedAtIso: string,
): Promise<void> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { error } = await supabase
    .from("inbound_webhook_sources")
    .update({ last_used_at: usedAtIso })
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (error) throw error;
}

// ------------------------------------------------------------
// Resolutor por slug (ENDPOINT público — pre-tenant)
// ------------------------------------------------------------

/**
 * Resuelve la fuente (y su org) por el slug de la URL. Corre en el borde
 * antes de establecer tenant context → cliente admin directo. El slug es
 * globalmente único (0038). Devuelve null si no existe.
 */
export async function findInboundWebhookSourceBySlug(
  slug: string,
): Promise<InboundWebhookSourceRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("inbound_webhook_sources")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  return (data as InboundWebhookSourceRow) ?? null;
}
