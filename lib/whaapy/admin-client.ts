import "server-only";
import { WHAAPY_API_BASE } from "@/lib/whaapy/config";
import { getWhaapyApiKey } from "@/lib/vault";
import type { UUID } from "@/lib/types/database";

/**
 * Cliente outbound a Whaapy API (M4).
 *
 * Autenticación: header `Authorization: Bearer <api_key>` (api_key
 * server-side vive en `organizations.vault_keys.whaapy.api_key` —
 * SOP de rotación 90 días en CLAUDE.md).
 *
 * Errores:
 *   - 4xx no retriables (excepto 409 que el caller convierte en enlace).
 *   - 429 + 5xx retriables → Inngest reintenta automáticamente.
 *   - timeout 30s — Whaapy retry policy es 3 intentos 2s/4s/8s; nuestro
 *     wrapper Inngest agrega capa adicional con backoff exponencial.
 */

export interface WhaapyClientContext {
  organizationId: UUID;
}

export class WhaapyApiError extends Error {
  public readonly status: number;
  public readonly body: unknown;
  public readonly retriable: boolean;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "WhaapyApiError";
    this.status = status;
    this.body = body;
    this.retriable = status === 429 || (status >= 500 && status < 600);
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

async function whaapyFetch(
  ctx: WhaapyClientContext,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const apiKey = await getWhaapyApiKey(ctx.organizationId);
  const url = path.startsWith("http") ? path : `${WHAAPY_API_BASE}${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("content-type")) {
    headers.set("Content-Type", "application/json");
  }

  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { timeoutMs: _t, ...rest } = init;
    void _t;
    return await fetch(url, { ...rest, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function whaapyRest<T = unknown>(
  ctx: WhaapyClientContext,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await whaapyFetch(ctx, path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new WhaapyApiError(
      `whaapy_rest_failed: ${method} ${path} status=${res.status}`,
      res.status,
      safeJson(text),
    );
  }
  if (res.status === 204) return undefined as unknown as T;
  const txt = await res.text();
  if (!txt) return undefined as unknown as T;
  try {
    return JSON.parse(txt) as T;
  } catch {
    throw new WhaapyApiError(
      `whaapy_rest_invalid_json: ${method} ${path}`,
      res.status,
      txt,
    );
  }
}

/**
 * Variante que tolera 409 conflict — retorna el body parseado en
 * lugar de lanzar. Usado por el outbound `create_from_shopify` para
 * recuperar `existing_contact_id` del payload de error.
 */
export async function whaapyRestWith409<T = unknown>(
  ctx: WhaapyClientContext,
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; status: number; body: unknown }> {
  const res = await whaapyFetch(ctx, path, {
    method,
    body: JSON.stringify(body),
  });
  if (res.ok) {
    if (res.status === 204) return { ok: true, data: undefined as unknown as T };
    const txt = await res.text();
    if (!txt) return { ok: true, data: undefined as unknown as T };
    return { ok: true, data: JSON.parse(txt) as T };
  }
  if (res.status === 409) {
    const txt = await res.text();
    return { ok: false, status: 409, body: safeJson(txt) };
  }
  const text = await res.text();
  throw new WhaapyApiError(
    `whaapy_rest_failed: ${method} ${path} status=${res.status}`,
    res.status,
    safeJson(text),
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
