import "server-only";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getServerEnv } from "@/lib/env";
import type { UUID } from "@/lib/types/database";

/**
 * Vault layer (M3) — credenciales por organización.
 *
 * Decisión MVP:
 *   - `organizations.vault_keys` JSONB es el store por-org.
 *     Forma: { shopify: { client_id, client_secret, access_token?,
 *                          access_token_obtained_at?,
 *                          access_token_expires_at? },
 *              whaapy: { api_key } }
 *   - Fallback a env (.env.local + Vercel env) para single-org MVP.
 *     M3 opera contra la única org Centr; cuando se agreguen orgs
 *     (Rustr, etc.) el operador pobla `vault_keys` por organización.
 *   - El access_token se obtiene en runtime vía client_credentials
 *     grant (cliente Shopify) y se cachea acá. No vive en env.
 *
 * Por qué JSONB y no Supabase Vault (vault.secrets + pgsodium):
 * la capa de cifrado at-rest la aporta Supabase a nivel disco;
 * el repo es público y los valores no viajan a código; service_role
 * es la única llave para leer JSONB. Migrar a `vault.create_secret`
 * en V2 cuando se necesite rotación granular vía panel.
 */

const VAULT_NAMESPACE_SHOPIFY = "shopify";
const VAULT_NAMESPACE_WHAAPY = "whaapy";
/**
 * Namespace del SEGUNDO Whaapy — el de Post-venta (integración de
 * webhooks bidireccionales). Es una instancia Whaapy INDEPENDIENTE del
 * de Venta (`whaapy`): credenciales propias, businessId propio, endpoint
 * propio. Aislar el bag garantiza que el Whaapy de Venta queda intacto.
 */
const VAULT_NAMESPACE_WHAAPY_POSTVENTA = "whaapy_postventa";

type ShopifyVaultBag = {
  client_id?: string;
  client_secret?: string;
  access_token?: string;
  access_token_obtained_at?: string;
  access_token_expires_at?: string;
};

type WhaapyVaultBag = {
  api_key?: string;
  /**
   * Secret HMAC del webhook Whaapy (M4). Devuelto por Whaapy al
   * registrar el webhook vía `POST /user-webhooks`. Único por
   * organización, separado del api_key (que es de las APIs outbound).
   */
  webhook_secret?: string;
  /**
   * Token compartido del webhook 3 del Whaapy de POST-VENTA (Option A).
   * El evento `contact.stage_changed` no existe en Whaapy, así que la
   * resolución entrante llega por una Automation `http_request` (trigger
   * `pipeline_stage_entered` sobre "Caso Resuelto") que NO firma HMAC. Se
   * autentica con este token (lo generamos nosotros, se configura en la
   * automation y se verifica constant-time en el endpoint). Solo aplica al
   * namespace `whaapy_postventa`.
   */
  inbound_token?: string;
};

type OrgVaultKeys = {
  [VAULT_NAMESPACE_SHOPIFY]?: ShopifyVaultBag;
  [VAULT_NAMESPACE_WHAAPY]?: WhaapyVaultBag;
  /** Credenciales del Whaapy de Post-venta (misma forma que el de Venta). */
  [VAULT_NAMESPACE_WHAAPY_POSTVENTA]?: WhaapyVaultBag;
};

async function readVaultKeys(organizationId: UUID): Promise<OrgVaultKeys> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("vault_keys")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw error;
  const raw = (data?.vault_keys ?? {}) as Record<string, unknown>;
  return raw as OrgVaultKeys;
}

async function writeVaultKeys(
  organizationId: UUID,
  next: OrgVaultKeys,
): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("organizations")
    .update({ vault_keys: next })
    .eq("id", organizationId);
  if (error) throw error;
}

async function patchVaultBag<K extends keyof OrgVaultKeys>(
  organizationId: UUID,
  namespace: K,
  patch: NonNullable<OrgVaultKeys[K]>,
): Promise<void> {
  const current = await readVaultKeys(organizationId);
  const prevBag = (current[namespace] ?? {}) as Record<string, unknown>;
  const patchObj = patch as Record<string, unknown>;
  const merged = { ...prevBag, ...patchObj } as NonNullable<OrgVaultKeys[K]>;
  const next: OrgVaultKeys = { ...current, [namespace]: merged };
  await writeVaultKeys(organizationId, next);
}

// ============================================================
// Shopify
// ============================================================

export async function getShopifyClientId(organizationId: UUID): Promise<string> {
  const bag = await readVaultKeys(organizationId);
  const fromVault = bag.shopify?.client_id;
  if (fromVault) return fromVault;
  const fromEnv = getServerEnv().SHOPIFY_API_KEY;
  if (!fromEnv) {
    throw new Error(
      `vault: SHOPIFY client_id no configurado (org ${organizationId} + env vacío)`,
    );
  }
  return fromEnv;
}

export async function getShopifyClientSecret(
  organizationId: UUID,
): Promise<string> {
  const bag = await readVaultKeys(organizationId);
  const fromVault = bag.shopify?.client_secret;
  if (fromVault) return fromVault;
  const fromEnv = getServerEnv().SHOPIFY_API_SECRET;
  if (!fromEnv) {
    throw new Error(
      `vault: SHOPIFY client_secret no configurado (org ${organizationId} + env vacío)`,
    );
  }
  return fromEnv;
}

/**
 * Webhook signing secret. En el flujo nuevo del Dev Dashboard
 * (post 1-ene-2026) Shopify firma webhooks con el Client Secret;
 * SHOPIFY_WEBHOOK_SECRET en .env.local debe igualar a
 * SHOPIFY_API_SECRET. Lo expone por separado por claridad operativa
 * (HMAC verify vs cliente API).
 */
export async function getShopifyWebhookSecret(
  organizationId: UUID,
): Promise<string> {
  const bag = await readVaultKeys(organizationId);
  const fromVault = bag.shopify?.client_secret;
  if (fromVault) return fromVault;
  const env = getServerEnv();
  const fromEnv = env.SHOPIFY_WEBHOOK_SECRET || env.SHOPIFY_API_SECRET;
  if (!fromEnv) {
    throw new Error(
      `vault: SHOPIFY webhook secret no configurado (org ${organizationId})`,
    );
  }
  return fromEnv;
}

export interface ShopifyAccessTokenCache {
  token: string;
  obtainedAt: string; // ISO
  expiresAt: string;  // ISO
}

export async function getCachedShopifyAccessToken(
  organizationId: UUID,
): Promise<ShopifyAccessTokenCache | null> {
  const bag = await readVaultKeys(organizationId);
  const s = bag.shopify;
  if (!s?.access_token || !s.access_token_expires_at) return null;
  // Margen 60s para evitar usar token a punto de expirar.
  if (new Date(s.access_token_expires_at).getTime() - 60_000 <= Date.now()) {
    return null;
  }
  return {
    token: s.access_token,
    obtainedAt: s.access_token_obtained_at ?? new Date().toISOString(),
    expiresAt: s.access_token_expires_at,
  };
}

export async function cacheShopifyAccessToken(
  organizationId: UUID,
  token: string,
  expiresInSeconds: number,
): Promise<void> {
  const now = new Date();
  const expires = new Date(now.getTime() + expiresInSeconds * 1000);
  await patchVaultBag(organizationId, VAULT_NAMESPACE_SHOPIFY, {
    access_token: token,
    access_token_obtained_at: now.toISOString(),
    access_token_expires_at: expires.toISOString(),
  });
}

export async function clearShopifyAccessTokenCache(
  organizationId: UUID,
): Promise<void> {
  const current = await readVaultKeys(organizationId);
  const prev = current.shopify ?? {};
  const next: ShopifyVaultBag = {
    client_id: prev.client_id,
    client_secret: prev.client_secret,
  };
  await writeVaultKeys(organizationId, { ...current, shopify: next });
}

export async function storeShopifyCredentials(
  organizationId: UUID,
  input: { clientId: string; clientSecret: string },
): Promise<void> {
  await patchVaultBag(organizationId, VAULT_NAMESPACE_SHOPIFY, {
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
}

// ============================================================
// Whaapy
// ============================================================

export async function getWhaapyApiKey(organizationId: UUID): Promise<string> {
  const bag = await readVaultKeys(organizationId);
  const fromVault = bag.whaapy?.api_key;
  if (fromVault) return fromVault;
  const fromEnv = getServerEnv().WHAAPY_API_KEY;
  if (!fromEnv) {
    throw new Error(
      `vault: WHAAPY api_key no configurado (org ${organizationId} + env vacío)`,
    );
  }
  return fromEnv;
}

export async function storeWhaapyApiKey(
  organizationId: UUID,
  apiKey: string,
): Promise<void> {
  await patchVaultBag(organizationId, VAULT_NAMESPACE_WHAAPY, { api_key: apiKey });
}

/**
 * Devuelve el secret HMAC del webhook Whaapy. Sin fallback a env —
 * el secret se obtiene únicamente al registrar el webhook contra
 * Whaapy via `POST /user-webhooks` y se persiste en Vault.
 */
export async function getWhaapyWebhookSecret(
  organizationId: UUID,
): Promise<string> {
  const bag = await readVaultKeys(organizationId);
  const fromVault = bag.whaapy?.webhook_secret;
  if (!fromVault) {
    throw new Error(
      `vault: WHAAPY webhook_secret no configurado (org ${organizationId}). ` +
        `Registra el webhook con scripts/whaapy/configure-webhook.ts.`,
    );
  }
  return fromVault;
}

export async function storeWhaapyWebhookSecret(
  organizationId: UUID,
  webhookSecret: string,
): Promise<void> {
  await patchVaultBag(organizationId, VAULT_NAMESPACE_WHAAPY, {
    webhook_secret: webhookSecret,
  });
}

// ============================================================
// Whaapy Post-venta (segundo Whaapy, independiente del de Venta)
// ============================================================

/**
 * api_key del Whaapy de Post-venta. Fallback a env
 * `WHAAPY_POSTVENTA_API_KEY` para el MVP single-org (Centr); cuando se
 * agreguen orgs se pobla `vault_keys.whaapy_postventa.api_key` por org.
 * Scopes esperados: funnels:read/write + contacts:read/write.
 */
export async function getWhaapyPostventaApiKey(
  organizationId: UUID,
): Promise<string> {
  const bag = await readVaultKeys(organizationId);
  const fromVault = bag.whaapy_postventa?.api_key;
  if (fromVault) return fromVault;
  const fromEnv = getServerEnv().WHAAPY_POSTVENTA_API_KEY;
  if (!fromEnv) {
    throw new Error(
      `vault: WHAAPY_POSTVENTA api_key no configurado (org ${organizationId} + env vacío)`,
    );
  }
  return fromEnv;
}

export async function storeWhaapyPostventaApiKey(
  organizationId: UUID,
  apiKey: string,
): Promise<void> {
  await patchVaultBag(organizationId, VAULT_NAMESPACE_WHAAPY_POSTVENTA, {
    api_key: apiKey,
  });
}

/**
 * Secret HMAC del webhook del Whaapy de Post-venta. Sin fallback a env —
 * se obtiene al registrar el webhook `contact.stage_changed` contra el
 * Whaapy de Post-venta y se persiste en Vault. Separado del secret del
 * Whaapy de Venta para que ambos endpoints verifiquen con su propia llave.
 */
export async function getWhaapyPostventaWebhookSecret(
  organizationId: UUID,
): Promise<string> {
  const bag = await readVaultKeys(organizationId);
  const fromVault = bag.whaapy_postventa?.webhook_secret;
  if (!fromVault) {
    throw new Error(
      `vault: WHAAPY_POSTVENTA webhook_secret no configurado (org ${organizationId}).`,
    );
  }
  return fromVault;
}

export async function storeWhaapyPostventaWebhookSecret(
  organizationId: UUID,
  webhookSecret: string,
): Promise<void> {
  await patchVaultBag(organizationId, VAULT_NAMESPACE_WHAAPY_POSTVENTA, {
    webhook_secret: webhookSecret,
  });
}

/**
 * Token compartido del webhook 3 (Option A — Automation `http_request`).
 * Sin fallback a env: vive solo en Vault. Lo genera el operador (o el
 * script de setup) y se configura idéntico en la automation de Whaapy.
 */
export async function getWhaapyPostventaInboundToken(
  organizationId: UUID,
): Promise<string> {
  const bag = await readVaultKeys(organizationId);
  const fromVault = bag.whaapy_postventa?.inbound_token;
  if (!fromVault) {
    throw new Error(
      `vault: WHAAPY_POSTVENTA inbound_token no configurado (org ${organizationId}).`,
    );
  }
  return fromVault;
}

export async function storeWhaapyPostventaInboundToken(
  organizationId: UUID,
  token: string,
): Promise<void> {
  await patchVaultBag(organizationId, VAULT_NAMESPACE_WHAAPY_POSTVENTA, {
    inbound_token: token,
  });
}
