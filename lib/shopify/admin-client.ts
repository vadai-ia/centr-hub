import "server-only";
import {
  buildShopifyAdminBaseUrl,
  buildShopifyOAuthTokenUrl,
} from "@/lib/shopify/config";
import {
  cacheShopifyAccessToken,
  clearShopifyAccessTokenCache,
  getCachedShopifyAccessToken,
  getShopifyClientId,
  getShopifyClientSecret,
} from "@/lib/vault";
import type { UUID } from "@/lib/types/database";

/**
 * Cliente Shopify Admin API (REST + GraphQL).
 *
 * Manejo de access_token (flujo Dev Dashboard post 1-ene-2026):
 *   1. Lee cache desde Vault. Si vigente con margen 60s → úsalo.
 *   2. Si no, invoca client_credentials grant contra Shopify
 *      (POST /admin/oauth/access_token) y cachea el resultado.
 *   3. Si el grant devuelve 401 (rotación de Client Secret, token
 *      revocado), invalida cache + relanza error descriptivo.
 *
 * Compatibilidad con Custom Apps clásicas: si el shop fue instalado
 * vía Custom App (pre-2026) y el access_token nunca expira, el
 * operador puede poblar `vault_keys.shopify.access_token` con
 * `access_token_expires_at` muy lejano y este cliente lo reutiliza
 * sin invocar el grant.
 */

export interface ShopifyAdminClientOptions {
  organizationId: UUID;
  shopDomain: string;
}

export class ShopifyApiError extends Error {
  public readonly status: number;
  public readonly body: unknown;
  public readonly retriable: boolean;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ShopifyApiError";
    this.status = status;
    this.body = body;
    // 429 (rate limit), 5xx (transient) son retriables; 4xx no.
    this.retriable = status === 429 || (status >= 500 && status < 600);
  }
}

/**
 * Extrae el motivo de validación legible del body de error de Shopify
 * para mostrárselo al usuario. Shopify responde 422 con formas variadas:
 *   { "errors": { "phone": ["is invalid"], "address": ["Country ..."] } }
 *   { "errors": "Not Found" }
 *   "<texto plano>"
 * Devuelve un string compacto tipo "phone: is invalid; address: Country..."
 * o null si no se puede extraer. SOLO lee `errors` (feedback de
 * validación, seguro de mostrar) — nunca vuelca el body completo, que
 * podría arrastrar datos del request.
 */
export function extractShopifyErrorMessage(body: unknown): string | null {
  if (typeof body === "string") {
    const t = body.trim();
    return t.length > 0 ? t.slice(0, 300) : null;
  }
  if (!body || typeof body !== "object") return null;
  const errors = (body as { errors?: unknown }).errors;
  if (errors === undefined || errors === null) return null;
  if (typeof errors === "string") {
    return errors.trim().slice(0, 300) || null;
  }
  if (Array.isArray(errors)) {
    const parts = errors.map((e) => String(e)).filter((s) => s.trim());
    return parts.length > 0 ? parts.join("; ").slice(0, 300) : null;
  }
  if (typeof errors === "object") {
    const parts: string[] = [];
    for (const [field, val] of Object.entries(errors as Record<string, unknown>)) {
      const msgs = Array.isArray(val)
        ? val.map((v) => String(v)).join(", ")
        : String(val);
      if (msgs.trim()) parts.push(`${field}: ${msgs}`);
    }
    return parts.length > 0 ? parts.join("; ").slice(0, 300) : null;
  }
  return null;
}

interface GrantResponse {
  access_token: string;
  scope?: string;
  expires_in?: number;
}

const DEFAULT_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60; // 12h conservador

async function obtainAccessToken(opts: ShopifyAdminClientOptions): Promise<string> {
  const cached = await getCachedShopifyAccessToken(opts.organizationId);
  if (cached) return cached.token;

  const clientId = await getShopifyClientId(opts.organizationId);
  const clientSecret = await getShopifyClientSecret(opts.organizationId);

  const res = await fetch(buildShopifyOAuthTokenUrl(opts.shopDomain), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new ShopifyApiError(
      `shopify_grant_failed: status=${res.status}`,
      res.status,
      safeJson(text),
    );
  }

  const json = (await res.json()) as GrantResponse;
  if (!json.access_token) {
    throw new ShopifyApiError(
      "shopify_grant_failed: respuesta sin access_token",
      500,
      json,
    );
  }
  await cacheShopifyAccessToken(
    opts.organizationId,
    json.access_token,
    json.expires_in ?? DEFAULT_TOKEN_LIFETIME_SECONDS,
  );
  return json.access_token;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function shopifyFetch(
  opts: ShopifyAdminClientOptions,
  path: string,
  init: RequestInit & { retryOn401?: boolean } = {},
): Promise<Response> {
  const token = await obtainAccessToken(opts);
  const url = path.startsWith("http")
    ? path
    : `${buildShopifyAdminBaseUrl(opts.shopDomain)}${path}`;
  const headers = new Headers(init.headers);
  headers.set("X-Shopify-Access-Token", token);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("content-type")) {
    headers.set("Content-Type", "application/json");
  }
  const { retryOn401, ...rest } = init;
  const res = await fetch(url, { ...rest, headers });

  if (res.status === 401 && retryOn401 !== false) {
    // Token cacheado dejó de ser válido — invalida y reintenta UNA vez.
    await clearShopifyAccessTokenCache(opts.organizationId);
    return shopifyFetch(opts, path, { ...init, retryOn401: false });
  }
  return res;
}

export async function shopifyRest<T = unknown>(
  opts: ShopifyAdminClientOptions,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await shopifyFetch(opts, path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ShopifyApiError(
      `shopify_rest_failed: ${method} ${path} status=${res.status}`,
      res.status,
      safeJson(text),
    );
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: unknown }>;
  extensions?: unknown;
}

export async function shopifyGraphql<T = unknown>(
  opts: ShopifyAdminClientOptions,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await shopifyFetch(opts, "/graphql.json", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ShopifyApiError(
      `shopify_graphql_failed: status=${res.status}`,
      res.status,
      safeJson(text),
    );
  }
  const json = (await res.json()) as GraphqlResponse<T>;
  if (json.errors && json.errors.length > 0) {
    throw new ShopifyApiError(
      `shopify_graphql_errors: ${json.errors.map((e) => e.message).join("; ")}`,
      400,
      json.errors,
    );
  }
  if (!json.data) {
    throw new ShopifyApiError(
      "shopify_graphql_empty_data",
      500,
      json,
    );
  }
  return json.data;
}
