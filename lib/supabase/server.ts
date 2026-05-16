import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getClientEnv } from "@/lib/env";

/**
 * Cliente server con la sesión del usuario (anon_key + cookies).
 * RLS aplica via JWT — la organización activa se lee de la claim
 * `organization_id` que la app actualiza al elegir tenant.
 *
 * Para operaciones server-side que necesiten omitir el usuario
 * (workers de Inngest, webhooks públicos, scripts admin) usar
 * el `getSupabaseAdminClient()` SIEMPRE dentro de `withTenantContext`.
 */
export function getSupabaseServerClient() {
  const env = getClientEnv();
  // En App Router de Next 14.2, cookies() es async — pero el
  // helper de @supabase/ssr acepta el contrato sync/async indistinto
  // mientras lo expongamos via getter. Mantener la firma alineada
  // con la versión adjunta en package.json.
  const cookieStore = cookies();

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Llamado desde un Server Component — silenciamos; el
            // refresh real ocurre vía middleware (M2).
          }
        },
      },
    },
  );
}
