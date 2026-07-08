import "server-only";
import { listManageableMemberships, getAuthUserInfo } from "@/lib/db/users";
import { getPostventaResolverEmail } from "@/lib/whaapy-postventa/config";
import type { UUID } from "@/lib/types/database";

/**
 * Resuelve el user_id (== user_profiles.id, FK de resolved_by_user_id) del
 * usuario "Customer Success" al que se atribuye una resolución venida de
 * Whaapy (webhook 3), a partir de `POSTVENTA_RESOLVER_EMAIL`.
 *
 * Se resuelve POR MEMBERSHIP (getUserById targetado), NO por el bulk
 * `listUsers()` — que falla en este entorno con "Database error finding
 * users" (ver lib/db/users.ts). Mismo patrón que admin-users.ts.
 *
 * Cachea el id por org en memoria (best-effort; el proceso serverless lo
 * recalcula tras reciclarse).
 */

const RESOLVER_CACHE = new Map<UUID, UUID>();

export async function resolvePostventaResolverUserId(
  organizationId: UUID,
): Promise<UUID | null> {
  const cached = RESOLVER_CACHE.get(organizationId);
  if (cached) return cached;

  const email = getPostventaResolverEmail();
  if (!email) return null;

  const memberships = await listManageableMemberships(organizationId);
  for (const m of memberships) {
    const info = await getAuthUserInfo(m.user_id);
    if (!info.loadError && info.email?.toLowerCase() === email) {
      RESOLVER_CACHE.set(organizationId, m.user_id);
      return m.user_id;
    }
  }
  return null;
}

/** Solo para tests: limpia la caché entre casos. */
export function __clearResolverCacheForTests(): void {
  RESOLVER_CACHE.clear();
}
