import "server-only";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { UUID } from "@/lib/types/database";

/**
 * Vault layer (M3) — credenciales por organización.
 *
 * Decisión MVP:
 *   - `organizations.vault_keys` JSONB es el store por-org.
 *     Forma: { shopify: { client_id, client_secret, access_token?,
 *                          access_token_obtained_at?,
 *                          access_token_expires_at? },
 *              whaapy: { api_key, webhook_secret },
 *              whaapy_postventa: { api_key, webhook_secret, inbound_token } }
 *   - El access_token se obtiene en runtime vía client_credentials
 *     grant (cliente Shopify) y se cachea acá. No vive en env.
 *
 * FAIL-CLOSED (0046) — los getters NO caen a variables de entorno.
 * Hasta la pantalla Admin → Integraciones, `getShopifyClientId` y compañía
 * caían a `SHOPIFY_API_KEY` / `WHAAPY_API_KEY` / … cuando el bag de la
 * organización estaba vacío. Con una sola organización eso era cómodo; con
 * dos es un fallo de aislamiento: la organización nueva, sin credenciales
 * propias, autentica SILENCIOSAMENTE con las de la primera — escribiría en la
 * tienda Shopify y en el Whaapy equivocados. El env es global; la credencial
 * es por-tenant, y mezclarlos no tiene una versión segura.
 *
 * Ahora cada credencial se resuelve EXCLUSIVAMENTE del bag de su organización
 * y su ausencia es un error explícito y accionable, no una degradación muda.
 * Para materializar el env existente hacia Vault antes del deploy:
 *   npm run maintenance:adopt-env-credentials -- --org-slug <slug>
 *
 * Por qué JSONB y no Supabase Vault (vault.secrets + pgsodium):
 * la capa de cifrado at-rest la aporta Supabase a nivel disco;
 * el repo es público y los valores no viajan a código; service_role
 * es la única llave para leer JSONB. Migrar a `vault.create_secret`
 * en V2 cuando se necesite rotación granular vía panel.
 */

/**
 * Error de credencial ausente. Tipado propio para que la UI y los workers
 * distingan "no está configurada" (acción del admin) de "el proveedor
 * respondió mal" (incidente). El mensaje NUNCA incluye valores.
 */
export class VaultMissingCredentialError extends Error {
  public readonly namespace: string;
  public readonly key: string;
  public readonly organizationId: UUID;
  constructor(organizationId: UUID, namespace: string, key: string, hint: string) {
    super(
      `vault_missing_credential: ${namespace}.${key} no configurada para la organización ${organizationId}. ${hint}`,
    );
    this.name = "VaultMissingCredentialError";
    this.namespace = namespace;
    this.key = key;
    this.organizationId = organizationId;
  }
}

const CONFIGURE_HINT =
  "Configúrala en Admin → Integraciones (las variables de entorno ya no se usan como respaldo).";

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
  if (!fromVault) {
    throw new VaultMissingCredentialError(
      organizationId,
      VAULT_NAMESPACE_SHOPIFY,
      "client_id",
      CONFIGURE_HINT,
    );
  }
  return fromVault;
}

export async function getShopifyClientSecret(
  organizationId: UUID,
): Promise<string> {
  const bag = await readVaultKeys(organizationId);
  const fromVault = bag.shopify?.client_secret;
  if (!fromVault) {
    throw new VaultMissingCredentialError(
      organizationId,
      VAULT_NAMESPACE_SHOPIFY,
      "client_secret",
      CONFIGURE_HINT,
    );
  }
  return fromVault;
}

/**
 * Webhook signing secret. En el flujo nuevo del Dev Dashboard
 * (post 1-ene-2026) Shopify firma webhooks con el Client Secret — por eso
 * este getter lee la MISMA clave `client_secret`. Se expone aparte por
 * claridad operativa (HMAC verify vs cliente API) y para poder separarlos
 * si Shopify vuelve a emitir dos valores distintos.
 */
export async function getShopifyWebhookSecret(
  organizationId: UUID,
): Promise<string> {
  const bag = await readVaultKeys(organizationId);
  const fromVault = bag.shopify?.client_secret;
  if (!fromVault) {
    throw new VaultMissingCredentialError(
      organizationId,
      VAULT_NAMESPACE_SHOPIFY,
      "client_secret",
      CONFIGURE_HINT,
    );
  }
  return fromVault;
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
  if (!fromVault) {
    throw new VaultMissingCredentialError(
      organizationId,
      VAULT_NAMESPACE_WHAAPY,
      "api_key",
      CONFIGURE_HINT,
    );
  }
  return fromVault;
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
    throw new VaultMissingCredentialError(
      organizationId,
      VAULT_NAMESPACE_WHAAPY,
      "webhook_secret",
      CONFIGURE_HINT,
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
 * api_key del Whaapy de Post-venta. Sin fallback a env (fail-closed, 0046):
 * vive por organización en `vault_keys.whaapy_postventa.api_key`.
 * Scopes esperados: funnels:read/write + contacts:read/write.
 */
export async function getWhaapyPostventaApiKey(
  organizationId: UUID,
): Promise<string> {
  const bag = await readVaultKeys(organizationId);
  const fromVault = bag.whaapy_postventa?.api_key;
  if (!fromVault) {
    throw new VaultMissingCredentialError(
      organizationId,
      VAULT_NAMESPACE_WHAAPY_POSTVENTA,
      "api_key",
      CONFIGURE_HINT,
    );
  }
  return fromVault;
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
    throw new VaultMissingCredentialError(
      organizationId,
      VAULT_NAMESPACE_WHAAPY_POSTVENTA,
      "webhook_secret",
      CONFIGURE_HINT,
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
    throw new VaultMissingCredentialError(
      organizationId,
      VAULT_NAMESPACE_WHAAPY_POSTVENTA,
      "inbound_token",
      CONFIGURE_HINT,
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

// ============================================================
// Superficie de administración (0046) — presencia y borrado
// ============================================================

/** Namespace de Vault por proveedor de la pantalla de Integraciones. */
const NAMESPACE_BY_PROVIDER = {
  shopify: VAULT_NAMESPACE_SHOPIFY,
  whaapy_venta: VAULT_NAMESPACE_WHAAPY,
  whaapy_postventa: VAULT_NAMESPACE_WHAAPY_POSTVENTA,
} as const;

export type VaultProviderKey = keyof typeof NAMESPACE_BY_PROVIDER;

/**
 * Qué credenciales EXISTEN por proveedor. Devuelve solo las KEYS presentes,
 * nunca los valores — es lo que consume la derivación de salud y la pantalla.
 * `access_token*` se excluye: es cache derivado, no una credencial que el
 * admin capture, y su presencia no dice nada sobre si la conexión está lista.
 */
export async function getVaultCredentialPresence(
  organizationId: UUID,
): Promise<Record<VaultProviderKey, string[]>> {
  const bag = await readVaultKeys(organizationId);
  const pick = (obj: Record<string, unknown> | undefined): string[] =>
    Object.entries(obj ?? {})
      .filter(([k, v]) => !k.startsWith("access_token") && typeof v === "string" && v.length > 0)
      .map(([k]) => k);
  return {
    shopify: pick(bag.shopify as Record<string, unknown> | undefined),
    whaapy_venta: pick(bag.whaapy as Record<string, unknown> | undefined),
    whaapy_postventa: pick(bag.whaapy_postventa as Record<string, unknown> | undefined),
  };
}

/**
 * Escribe un conjunto de credenciales de un proveedor (merge sobre el bag).
 * Solo las keys provistas se tocan — omitir una la deja como estaba, que es
 * lo que permite "rotar solo el secret" sin re-capturar el resto.
 */
export async function storeProviderCredentials(
  organizationId: UUID,
  provider: VaultProviderKey,
  values: Record<string, string>,
): Promise<void> {
  const patch: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "string" && v.trim().length > 0) patch[k] = v.trim();
  }
  if (Object.keys(patch).length === 0) return;
  await patchVaultBag(
    organizationId,
    NAMESPACE_BY_PROVIDER[provider] as keyof OrgVaultKeys,
    patch as unknown as NonNullable<OrgVaultKeys[keyof OrgVaultKeys]>,
  );
  // Cambiar el Client Secret invalida cualquier access_token derivado de él:
  // el grant se re-ejecuta con el secret nuevo en la siguiente llamada.
  if (provider === "shopify" && patch.client_secret) {
    await clearShopifyAccessTokenCache(organizationId);
  }
}

/**
 * Borra TODO el bag de credenciales de un proveedor (desconectar).
 * No toca ninguna otra columna: el histórico y los ids externos se conservan
 * intactos para que reconectar el MISMO sistema restaure el enlace.
 */
export async function clearProviderCredentials(
  organizationId: UUID,
  provider: VaultProviderKey,
): Promise<void> {
  const current = await readVaultKeys(organizationId);
  const next = { ...current };
  delete next[NAMESPACE_BY_PROVIDER[provider] as keyof OrgVaultKeys];
  await writeVaultKeys(organizationId, next);
}
