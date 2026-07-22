import "server-only";
import { getRedisClient } from "@/lib/redis/client";
import { listActiveRealVendors } from "@/lib/db/users";
import type { UUID } from "@/lib/types/database";

/**
 * Reparto round-robin de asesor para leads que entran por webhook
 * (Bloque C de creación de leads). Los leads manuales NO usan esto —
 * el usuario elige el asesor explícitamente.
 *
 * Elegibilidad: `listActiveRealVendors` (vendedores activos, reales —
 * excluye el usuario sistema "Histórico", R10). Orden estable por
 * `created_at asc`.
 *
 * Contador: `INCR` atómico en Redis por organización (`leadrr:{orgId}`).
 * Atómico ⇒ dos webhooks concurrentes reciben contadores distintos y no
 * pisan el mismo vendedor. El puntero es persistente (no expira) para que
 * la rotación sobreviva entre requests. Redis ya es dependencia del path
 * de webhooks (dedup), así que no agrega infraestructura.
 *
 * Pool vacío (sin vendedores elegibles) → `advisorId: null`; el caller
 * (`createLead`) crea el lead SIN asignar y alerta al admin — nunca
 * bloquea la creación (riesgo levantado en el diagnóstico).
 */

const RR_KEY_PREFIX = "leadrr:";

/**
 * Selección pura, testeable sin Redis. `counter` es 1-based (Redis INCR
 * devuelve 1 en la primera llamada). Índice 0-based estable =
 * (counter - 1) mod n.
 */
export function selectRoundRobin<T>(items: T[], counter: number): T | null {
  const n = items.length;
  if (n === 0) return null;
  const idx = (((counter - 1) % n) + n) % n;
  return items[idx] ?? null;
}

/** INCR atómico del puntero de rotación de la org. */
export async function nextRoundRobinCounter(organizationId: UUID): Promise<number> {
  const redis = getRedisClient();
  return await redis.incr(`${RR_KEY_PREFIX}${organizationId}`);
}

export interface RoundRobinPick {
  /** membership.id del asesor elegido, o null si no hay pool elegible. */
  advisorId: UUID | null;
  /** Cantidad de vendedores elegibles al momento del reparto. */
  poolSize: number;
}

export async function pickRoundRobinAdvisor(
  organizationId: UUID,
): Promise<RoundRobinPick> {
  const vendors = await listActiveRealVendors(organizationId);
  if (vendors.length === 0) {
    return { advisorId: null, poolSize: 0 };
  }
  const counter = await nextRoundRobinCounter(organizationId);
  const chosen = selectRoundRobin(vendors, counter);
  return { advisorId: chosen ? chosen.id : null, poolSize: vendors.length };
}
