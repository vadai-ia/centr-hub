import "server-only";
import {
  requireTenantContext,
  type TenantContextRequiredError,
} from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import type { AdminSupabase } from "@/lib/supabase/admin";
import type { UUID } from "@/lib/types/database";

/**
 * Capa de acceso a datos — TODO query a Supabase desde código de
 * negocio pasa por aquí (Sección 3.2). El cliente admin se obtiene
 * dentro del scope del wrapper de tenant; sin contexto, se lanza
 * TenantContextRequiredError (Barrera 2 — R6).
 *
 * Las funciones de este módulo asumen que ya están corriendo
 * DENTRO de `withTenantContext(...)`.
 */

export interface TenantScopedClient {
  organizationId: UUID;
  supabase: AdminSupabase;
}

export function getTenantScopedClient(): TenantScopedClient {
  // requireTenantContext lanza TenantContextRequiredError si no hay
  // contexto activo — este es el único punto de entrada del data layer.
  const ctx = requireTenantContext();
  return {
    organizationId: ctx.organizationId,
    supabase: getSupabaseAdminClient(),
  };
}

// Re-export para que los servicios puedan tipar el error.
export type { TenantContextRequiredError };
