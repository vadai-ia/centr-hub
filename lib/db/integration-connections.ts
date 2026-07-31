import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type {
  IntegrationConnectionRow,
  IntegrationProvider,
  IntegrationStatus,
  Json,
  UUID,
} from "@/lib/types/database";
import type { LinkedRowCounts } from "@/lib/services/integration-providers";
import { EMPTY_LINKED_COUNTS } from "@/lib/services/integration-providers";

/**
 * Capa de datos de las conexiones externas (0046).
 *
 * La tabla guarda SOLO metadata no secreta. Las credenciales viven en
 * `organizations.vault_keys` y se leen/escriben por `lib/vault` — nada de
 * este módulo toca un secreto, así que ninguna consulta de aquí puede
 * filtrarlo.
 */

export async function listIntegrationConnections(): Promise<IntegrationConnectionRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("integration_connections")
    .select("*")
    .eq("organization_id", organizationId);
  if (error) throw error;
  return (data ?? []) as IntegrationConnectionRow[];
}

export async function getIntegrationConnection(
  provider: IntegrationProvider,
): Promise<IntegrationConnectionRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("integration_connections")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw error;
  return (data as IntegrationConnectionRow) ?? null;
}

/**
 * Garantiza que exista la fila de la conexión. El backfill de 0046 y
 * `bootstrap_organization` las crean, pero una organización creada por otra
 * vía (insert directo) no las tendría — y el reemplazo hace `FOR UPDATE`
 * sobre esta fila, así que su ausencia sería un error opaco.
 */
export async function ensureIntegrationConnection(
  provider: IntegrationProvider,
): Promise<IntegrationConnectionRow> {
  const existing = await getIntegrationConnection(provider);
  if (existing) return existing;
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("integration_connections")
    .insert({ organization_id: organizationId, provider })
    .select("*")
    .single();
  if (error) throw error;
  return data as IntegrationConnectionRow;
}

export async function updateIntegrationConnection(
  provider: IntegrationProvider,
  patch: {
    status?: IntegrationStatus;
    credential_last4?: Json;
    callback_url?: string | null;
    webhook_registered_at?: string | null;
    last_test_at?: string | null;
    last_test_ok?: boolean | null;
    last_test_message?: string | null;
    connected_at?: string | null;
    disconnected_at?: string | null;
    updated_by_user_id?: UUID | null;
  },
): Promise<IntegrationConnectionRow> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("integration_connections")
    .update(patch)
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .select("*")
    .single();
  if (error) throw error;
  return data as IntegrationConnectionRow;
}

// ------------------------------------------------------------
// RPCs (0046) — dry-run y reemplazo atómico
// ------------------------------------------------------------

function coerceCounts(raw: unknown): LinkedRowCounts {
  if (!raw || typeof raw !== "object") return { ...EMPTY_LINKED_COUNTS };
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);
  return {
    contacts: num(o.contacts),
    opportunities: num(o.opportunities),
    orders: num(o.orders),
    memberships: num(o.memberships),
    tag_mappings: num(o.tag_mappings),
  };
}

/**
 * Dry-run: cuántas filas quedarían colgando si se reemplaza el sistema
 * externo. Read-only. Comparte definición de "enlazado" con el desenlace del
 * RPC de reemplazo (misma función SQL) — por eso lo que se muestra es
 * exactamente lo que se ejecutaría.
 */
export async function countIntegrationLinkedRows(
  organizationId: UUID,
  provider: IntegrationProvider,
): Promise<LinkedRowCounts> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.rpc("count_integration_linked_rows", {
    p_organization_id: organizationId,
    p_provider: provider,
  });
  if (error) throw error;
  return coerceCounts(data);
}

export interface ReplaceConnectionResult {
  provider: IntegrationProvider;
  generation: number;
  unlinked: LinkedRowCounts;
}

/**
 * Reemplazo ATÓMICO (RPC 0046): cambia el discriminador, desenlaza toda
 * identidad externa del proveedor, limpia su bag de Vault, sube la generación
 * y deja audit. Sin bloque EXCEPTION en SQL → si algo falla, no queda nada a
 * medias (un discriminador nuevo con ids viejos es exactamente el estado que
 * fusiona contactos de dos sistemas distintos).
 */
export async function replaceIntegrationConnection(input: {
  organizationId: UUID;
  provider: IntegrationProvider;
  newDiscriminator: string;
  actorUserId: UUID | null;
  newStoreUrl?: string | null;
}): Promise<ReplaceConnectionResult> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.rpc("replace_integration_connection", {
    p_organization_id: input.organizationId,
    p_provider: input.provider,
    p_new_discriminator: input.newDiscriminator,
    p_actor_user_id: input.actorUserId,
    p_new_store_url: input.newStoreUrl ?? null,
  });
  if (error) throw error;
  const o = (data ?? {}) as Record<string, unknown>;
  return {
    provider: input.provider,
    generation: typeof o.generation === "number" ? o.generation : Number(o.generation ?? 0) || 0,
    unlinked: coerceCounts(o.unlinked),
  };
}
