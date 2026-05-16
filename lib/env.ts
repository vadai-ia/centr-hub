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
 */
import { z } from "zod";

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

const serverSchema = clientSchema.extend({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  INNGEST_EVENT_KEY: z.string().min(1).optional(),
  INNGEST_SIGNING_KEY: z.string().min(1).optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
  SHOPIFY_WEBHOOK_SECRET: z.string().min(1).optional(),
  WHAAPY_API_KEY: z.string().min(1).optional(),
});

function parseClient() {
  const parsed = clientSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
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
