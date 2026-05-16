import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/lib/env";

/**
 * Cliente admin con service_role_key.
 *
 * service_role_key bypassea RLS — la única defensa de tenant
 * sobre este cliente es el wrapper `withTenantContext` (Barrera 2,
 * Sección 3.7). NO usar este cliente directamente desde código
 * de aplicación; siempre vía el wrapper.
 *
 * El marker `server-only` produce build-error si alguien lo
 * importa desde un Client Component.
 *
 * NOTA M1: el cliente se tipa sin generic `Database` por incompatibilidad
 * con la forma estricta que supabase-js 2.105 espera (requiere
 * `Relationships` por tabla y marker `__InternalSupabase`).
 * Los tipos fuertes vienen de `lib/types/database` aplicados como
 * retorno explícito en cada función del data layer. Cuando un
 * milestone posterior habilite el Supabase CLI, este archivo se
 * actualiza a `SupabaseClient<Database>` con los tipos generados
 * por `supabase gen types typescript`.
 * Ver ERRORES.md → "supabase-js 2.105 — Database type hand-written incompatible".
 */
export type AdminSupabase = SupabaseClient;

let cached: AdminSupabase | null = null;

export function getSupabaseAdminClient(): AdminSupabase {
  if (cached) return cached;
  const env = getServerEnv();
  cached = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        headers: { "x-centrhub-client": "admin" },
      },
    },
  );
  return cached;
}
