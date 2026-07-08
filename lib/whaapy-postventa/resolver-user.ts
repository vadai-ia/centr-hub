import "server-only";
import { getOrganizationById, updateOrganization } from "@/lib/db/organizations";
import type { Json, UUID } from "@/lib/types/database";

/**
 * Resolutor de la resolución entrante (webhook 3): el usuario "Customer
 * Success" al que se atribuye archivar un caso venido de Whaapy.
 *
 * ANCLA ESTABLE: se guarda el `user_id` (== user_profiles.id, FK de
 * `opportunities.resolved_by_user_id`) en `organizations.config.postventa.
 * resolver_user_id`. NO se resuelve por email ni por nombre — ambos son
 * mutables (el email es una credencial editable en M9.2; el nombre puede
 * renombrarse/tener typos). Cambiar la PERSONA detrás de "Customer Success"
 * = editar email/nombre de ese membership en la plataforma; el `user_id` no
 * cambia (repair-in-place lo preserva) → la atribución nunca se rompe.
 *
 * Para apuntar a OTRO membership (cambio de resolutor, no de persona), se
 * actualiza este único id con `storePostventaResolverUserId` (o SQL).
 */

const CONFIG_KEY = "postventa" as const;
const RESOLVER_FIELD = "resolver_user_id" as const;

export async function resolvePostventaResolverUserId(
  organizationId: UUID,
): Promise<UUID | null> {
  const org = await getOrganizationById(organizationId);
  if (!org) return null;
  const config = (org.config ?? {}) as Record<string, unknown>;
  const postventa = (config[CONFIG_KEY] ?? {}) as Record<string, unknown>;
  const id = postventa[RESOLVER_FIELD];
  return typeof id === "string" && id ? (id as UUID) : null;
}

/**
 * Fija el resolutor por su `user_id` estable (merge no destructivo en
 * `organizations.config.postventa.resolver_user_id`). Lo llama el seed de
 * Customer Success; también puede correrse para repuntar a otro membership.
 */
export async function storePostventaResolverUserId(
  organizationId: UUID,
  userId: UUID,
): Promise<void> {
  const org = await getOrganizationById(organizationId);
  const config = (org?.config ?? {}) as Record<string, unknown>;
  const postventa = (config[CONFIG_KEY] ?? {}) as Record<string, unknown>;
  const nextConfig = {
    ...config,
    [CONFIG_KEY]: { ...postventa, [RESOLVER_FIELD]: userId },
  } as Json;
  await updateOrganization(organizationId, { config: nextConfig });
}
