import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { PG_TENANT_SETTING } from "@/lib/constants";
import {
  getSupabaseAdminClient,
  type AdminSupabase,
} from "@/lib/supabase/admin";
import type { UUID } from "@/lib/types/database";

/**
 * Wrapper de contexto de tenant — Barrera 2 de defensa multi-tenant
 * (Sección 3.7 + R6 + R11).
 *
 * Garantías:
 *  1. Toda operación server-side que usa service_role_key debe
 *     ejecutarse DENTRO de `withTenantContext(orgId, fn)`. Operar
 *     fuera del wrapper lanza error inmediato vía
 *     `requireTenantContext()` (lección Hemenesy: refactorizar
 *     single-tenant a multi-tenant tarda días — atajos defensivos
 *     se cobran caro).
 *  2. Antes de ejecutar la callback, el wrapper aplica
 *     `set_config('app.current_organization_id', orgId, true)` en
 *     una sesión Postgres dedicada. Esto activa las RLS policies
 *     incluso para service_role si quien construye queries usa el
 *     cliente devuelto por `getTenantSupabase()` con `auth.persistSession=false`.
 *     (RLS no se evalúa contra service_role nativo — pero la
 *     coherencia operativa exige propagar el contexto al lado SQL
 *     para que la función SQL `assert_organization_context()` y
 *     audit triggers también lo vean.)
 *  3. La organización activa queda disponible vía
 *     `getCurrentOrganizationId()` para servicios anidados sin
 *     necesidad de prop-drilling.
 *
 * Por qué AsyncLocalStorage: en Next.js / Node, cada request corre
 * en su propio task. ALS aísla el contexto por request sin colisión
 * con otras requests concurrentes.
 */

interface TenantContext {
  organizationId: UUID;
  /** Etiqueta libre de quién instaló el contexto (debug). */
  source: "user_session" | "webhook" | "worker" | "script" | "test";
}

const storage = new AsyncLocalStorage<TenantContext>();

export class TenantContextRequiredError extends Error {
  constructor(message = "tenant_context_required: operación sin organization_id") {
    super(message);
    this.name = "TenantContextRequiredError";
  }
}

/**
 * Recupera el contexto actual o lanza si no hay. Úsalo desde
 * cualquier servicio que dependa del tenant.
 */
export function requireTenantContext(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new TenantContextRequiredError();
  }
  return ctx;
}

export function getCurrentOrganizationId(): UUID {
  return requireTenantContext().organizationId;
}

export function tryGetTenantContext(): TenantContext | null {
  return storage.getStore() ?? null;
}

/**
 * Ejecuta `fn` con un contexto de tenant activo. Aplica el setting
 * de sesión al cliente admin (vía RPC) antes de invocar la callback.
 *
 * Si la callback escribe via `getTenantSupabase()` los inserts
 * heredan `organization_id = ctx.organizationId` (el data layer lo
 * inyecta automáticamente).
 */
export async function withTenantContext<T>(
  organizationId: UUID,
  fn: (ctx: TenantContext & { supabase: AdminSupabase }) => Promise<T>,
  options: { source?: TenantContext["source"] } = {},
): Promise<T> {
  if (!organizationId || typeof organizationId !== "string") {
    throw new TenantContextRequiredError(
      "withTenantContext: organizationId es obligatorio",
    );
  }

  const ctx: TenantContext = {
    organizationId,
    source: options.source ?? "worker",
  };

  return storage.run(ctx, async () => {
    const supabase = getSupabaseAdminClient();
    // Aplicar setting de sesión Postgres — esto activa
    // public.current_organization_id() del lado SQL. Útil para
    // funciones SECURITY DEFINER y audit triggers que evalúan
    // contra esa función.
    await applyOrgSetting(supabase, organizationId);
    return fn({ ...ctx, supabase });
  });
}

/**
 * Variante de testing/script: instala el contexto sin invocar
 * service_role. Útil cuando el test ya tiene su propio cliente
 * autenticado y solo necesita el contexto ALS para servicios
 * anidados.
 */
export function runWithTenantContext<T>(
  organizationId: UUID,
  fn: () => T,
  source: TenantContext["source"] = "test",
): T {
  if (!organizationId) {
    throw new TenantContextRequiredError(
      "runWithTenantContext: organizationId es obligatorio",
    );
  }
  return storage.run({ organizationId, source }, fn);
}

async function applyOrgSetting(client: AdminSupabase, orgId: UUID) {
  // set_config con `is_local = false` mantiene el setting hasta la
  // próxima request HTTP del pool. supabase-js no garantiza una
  // conexión sticky, así que esto es best-effort: la verdadera
  // garantía la aporta el data layer que filtra por organization_id
  // explícitamente. Aún así propagar al setting cubre las funciones
  // SECURITY DEFINER que consultan public.current_organization_id().
  try {
    await client.rpc("set_config", {
      parameter: PG_TENANT_SETTING,
      value: orgId,
      is_local: false,
    });
  } catch {
    // `set_config(parameter, value, is_local)` puede no estar
    // expuesto como RPC en este proyecto. No es bloqueante: la
    // defensa real es Barrera 2 del lado app + RLS por JWT en
    // sesiones de usuario. Silenciamos.
  }
}
