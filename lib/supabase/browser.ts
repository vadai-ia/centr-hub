"use client";
import { createBrowserClient } from "@supabase/ssr";
import { getClientEnv } from "@/lib/env";

/**
 * Cliente browser para Client Components. Usa anon_key y respeta
 * RLS (Barrera 1). La organización activa se infiere del JWT (claim
 * `organization_id`).
 *
 * Sin generic `Database` por compatibilidad — ver nota en
 * `lib/supabase/admin.ts`.
 */
export function getSupabaseBrowserClient() {
  const env = getClientEnv();
  return createBrowserClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
