import "server-only";
import { WHAAPY_API_BASE } from "@/lib/whaapy/config";
import { WhaapyApiError } from "@/lib/whaapy/admin-client";
import { getWhaapyPostventaApiKey } from "@/lib/vault";
import type { UUID } from "@/lib/types/database";

/**
 * Cliente outbound al Whaapy de POST-VENTA — instancia INDEPENDIENTE del
 * Whaapy de Venta. Deliberadamente separado del `admin-client.ts` de Venta
 * (mismo host, misma forma de API) para que el Whaapy de Venta quede
 * intacto: acá se resuelve el api_key del namespace `whaapy_postventa`.
 *
 * Reusa `WhaapyApiError` (misma semántica de retriable: 429 + 5xx) para
 * que el worker de Inngest reintente igual que el outbound de Venta.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

async function postventaFetch(
  organizationId: UUID,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const apiKey = await getWhaapyPostventaApiKey(organizationId);
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

/** REST genérico contra el Whaapy de Post-venta. */
export async function whaapyPostventaRest<T = unknown>(
  organizationId: UUID,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await postventaFetch(organizationId, path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new WhaapyApiError(
      `whaapy_postventa_rest_failed: ${method} ${path} status=${res.status}`,
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
      `whaapy_postventa_rest_invalid_json: ${method} ${path}`,
      res.status,
      txt,
    );
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
