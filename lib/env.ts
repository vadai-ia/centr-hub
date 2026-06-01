/**
 * Validación de variables de entorno con Zod (Sección 3.2).
 *
 * Se separa explícitamente:
 *   - `clientEnv`: las que sí pueden viajar al navegador
 *     (NEXT_PUBLIC_*). Importable desde Client Components.
 *   - `serverEnv`: incluye secretos (SUPABASE_SERVICE_ROLE_KEY,
 *     INNGEST, WHAAPY, SHOPIFY). NUNCA importar desde código
 *     que ejecute en el browser — el bundler lo prohíbe vía
 *     marker `import "server-only"`.
 *
 * Variables con entrada diferida por milestone:
 *   - SHOPIFY_WEBHOOK_SECRET  → se configura en M3 (Custom App Shopify)
 *   - WHAAPY_API_KEY          → se configura en M3-M4
 *   Ambas se validan en startup solo como "string o ausente" (vacío permitido).
 *   El error descriptivo se lanza en runtime a través de los helpers
 *   getShopifyWebhookSecret() y getWhaapyApiKey() cuando se intenta usarlas.
 */
import { z } from "zod";

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  /**
   * URL del dashboard de Whaapy embebida en la pestaña Whaapy (M6 — B10).
   * Default seguro `https://app.whaapy.com` (URL canónica documentada
   * por Whaapy). Override por organización futura vive en Vault si V2
   * lo requiere; en MVP single-org un env var es suficiente.
   */
  NEXT_PUBLIC_WHAAPY_DASHBOARD_URL: z.string().url().optional(),
});

const serverSchema = clientSchema.extend({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  INNGEST_EVENT_KEY: z.string().min(1).optional(),
  INNGEST_SIGNING_KEY: z.string().min(1).optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
  // Shopify Dev Dashboard (flujo post 1-ene-2026). Requeridas desde
  // M3 — pero se aceptan vacías en el schema para no romper arranque
  // de milestones anteriores. Los helpers getShopifyClientId/Secret
  // del Vault aplican validación en runtime.
  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  SHOPIFY_WEBHOOK_SECRET: z.string().optional(),
  WHAAPY_API_KEY: z.string().optional(),
});

function parseClient() {
  const parsed = clientSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_WHAAPY_DASHBOARD_URL: process.env.NEXT_PUBLIC_WHAAPY_DASHBOARD_URL,
  });
  if (!parsed.success) {
    throw new Error(
      `Variables de entorno cliente inválidas: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function parseServer() {
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Variables de entorno server inválidas: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export type ClientEnv = z.infer<typeof clientSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;

let clientEnvCache: ClientEnv | null = null;
let serverEnvCache: ServerEnv | null = null;

export function getClientEnv(): ClientEnv {
  if (clientEnvCache) return clientEnvCache;
  clientEnvCache = parseClient();
  return clientEnvCache;
}

export function getServerEnv(): ServerEnv {
  if (serverEnvCache) return serverEnvCache;
  serverEnvCache = parseServer();
  return serverEnvCache;
}

/**
 * Accessors de uso tardío para variables que entran en M3+.
 * Llamar solo desde código de M3+ (webhooks Shopify, workers Whaapy).
 * Lanzar aquí da un error claro con contexto de milestone.
 */
export function getShopifyWebhookSecret(): string {
  const val = getServerEnv().SHOPIFY_WEBHOOK_SECRET;
  if (!val) {
    throw new Error(
      "SHOPIFY_WEBHOOK_SECRET no configurado. " +
        "Requerida desde M3 — agregar al crear la Custom App de Shopify.",
    );
  }
  return val;
}

export function getWhaapyApiKey(): string {
  const val = getServerEnv().WHAAPY_API_KEY;
  if (!val) {
    throw new Error(
      "WHAAPY_API_KEY no configurado. " +
        "Requerida desde M3-M4 — agregar al obtener el api_key de Whaapy.",
    );
  }
  return val;
}
