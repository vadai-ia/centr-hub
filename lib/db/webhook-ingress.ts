import "server-only";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { IntegrationProvider } from "@/lib/types/database";

/**
 * Observabilidad de ingreso de webhooks — capa compartida (0046).
 *
 * `whaapy_raw_webhooks` (0015/0016) es la ÚNICA tabla de ingreso que NO
 * depende de resolver el tenant. Eso es justo lo que la hace útil: los exit
 * paths más peligrosos (dominio desconocido, firma inválida) ocurren ANTES de
 * saber a qué organización pertenece el evento, así que no pueden escribir en
 * `audit_log` (su `organization_id` es NOT NULL). El nombre de la tabla quedó
 * de su origen en M4-debug; hoy la comparten los cuatro endpoints.
 *
 * Cada endpoint se distingue por `endpoint` y taggea su `exit_reason`.
 * Sin ese tag, un webhook rechazado es indistinguible de "el proveedor no
 * mandó nada" — que es exactamente cómo el endpoint de Shopify pudo devolver
 * 200 a una tienda desconocida durante meses sin dejar rastro.
 */

/** Valor de `whaapy_raw_webhooks.endpoint` por endpoint público. */
export const INGRESS_ENDPOINT = {
  shopify: "shopify",
  whaapyVenta: "productive",
  whaapyPostventa: "postventa",
  leads: "leads",
} as const;

export type IngressEndpoint = (typeof INGRESS_ENDPOINT)[keyof typeof INGRESS_ENDPOINT];

/** Endpoint que alimenta la tarjeta de cada proveedor en Admin → Integraciones. */
export const INGRESS_ENDPOINT_BY_PROVIDER: Record<IntegrationProvider, IngressEndpoint> = {
  shopify: INGRESS_ENDPOINT.shopify,
  whaapy_venta: INGRESS_ENDPOINT.whaapyVenta,
  whaapy_postventa: INGRESS_ENDPOINT.whaapyPostventa,
};

/**
 * `exit_reason` que significan "el evento NO se procesó por un problema de
 * configuración". Son los que la pantalla cuenta como rechazos: distinguen
 * "la integración está muda porque nadie escribe" de "está muda porque
 * estamos tirando todo lo que llega".
 */
export const CONFIG_FAILURE_EXIT_REASONS: readonly string[] = [
  "unknown_shop",
  "invalid_hmac",
  "missing_secret",
  "missing_business_id",
  "organization_not_found",
  "missing_token_config",
  "invalid_token",
  "missing_headers",
] as const;

/**
 * Persiste la request entrante ANTES de cualquier validación y devuelve el id
 * para que los exit paths taggeen. Falla en silencio por contrato: perder
 * observabilidad es preferible a romper el happy path (un 500 hacia el
 * proveedor desactiva el webhook tras N fallos).
 *
 * NO se persisten headers sensibles: la firma HMAC y cualquier portador de
 * credencial se redactan. El objetivo es diagnosticar routing y configuración,
 * no conservar secretos en una tabla sin RLS.
 */
const REDACTED_HEADERS = new Set([
  "authorization",
  "x-shopify-hmac-sha256",
  "x-webhook-signature",
  "x-centrhub-token",
  "cookie",
]);

export async function recordWebhookIngress(
  endpoint: IngressEndpoint,
  headers: Headers,
  bodyBuf: Buffer,
): Promise<string | null> {
  try {
    const headerMap: Record<string, string> = {};
    headers.forEach((v, k) => {
      headerMap[k] = REDACTED_HEADERS.has(k.toLowerCase()) ? "[redacted]" : v;
    });
    const rawBody = bodyBuf.toString("utf8");
    let body: unknown = null;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = null;
    }
    const { data, error } = await getSupabaseAdminClient()
      .from("whaapy_raw_webhooks")
      .insert({ headers: headerMap, body, raw_body: rawBody, endpoint })
      .select("id")
      .single();
    if (error) {
      // eslint-disable-next-line no-console
      console.error(
        "webhook_ingress_insert_failed",
        JSON.stringify({ endpoint, message: error.message }),
      );
      return null;
    }
    return (data as { id: string }).id;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "webhook_ingress_threw",
      JSON.stringify({ endpoint, message: (err as Error).message }),
    );
    return null;
  }
}

/** Taggea el path de salida. No-op si el insert inicial falló. Nunca lanza. */
export async function tagWebhookExitReason(
  rawId: string | null,
  reason: string,
): Promise<void> {
  if (!rawId) return;
  try {
    const { error } = await getSupabaseAdminClient()
      .from("whaapy_raw_webhooks")
      .update({ exit_reason: reason })
      .eq("id", rawId);
    if (error) {
      // eslint-disable-next-line no-console
      console.error(
        "webhook_ingress_exit_tag_failed",
        JSON.stringify({ rawId, reason, message: error.message }),
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "webhook_ingress_exit_tag_threw",
      JSON.stringify({ rawId, reason, message: (err as Error).message }),
    );
  }
}

export interface IngressStats {
  sinceIso: string;
  total: number;
  /** Eventos descartados por configuración (firma, tenant, credencial). */
  rejected: number;
  /** `exit_reason` más reciente, para nombrar el problema en la UI. */
  lastExitReason: string | null;
  lastReceivedAt: string | null;
}

/**
 * Métrica de ingreso reciente de un endpoint. Tabla sin `organization_id`, así
 * que la lectura es global por endpoint — aceptable porque solo devuelve
 * conteos y un `exit_reason` (nunca cuerpos ni cabeceras) y hoy la instalación
 * es de una organización. Si se agregan organizaciones con endpoints
 * compartidos, esta métrica pasa a ser "de la instalación", no del tenant:
 * documentarlo antes de exponerla como métrica per-org.
 */
export async function getIngressStats(
  endpoint: IngressEndpoint,
  sinceIso: string,
): Promise<IngressStats> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("whaapy_raw_webhooks")
    .select("exit_reason, received_at")
    .eq("endpoint", endpoint)
    .gte("received_at", sinceIso)
    .order("received_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ exit_reason: string | null; received_at: string }>;
  const rejected = rows.filter(
    (r) => r.exit_reason && CONFIG_FAILURE_EXIT_REASONS.includes(r.exit_reason),
  ).length;
  return {
    sinceIso,
    total: rows.length,
    rejected,
    lastExitReason: rows[0]?.exit_reason ?? null,
    lastReceivedAt: rows[0]?.received_at ?? null,
  };
}
