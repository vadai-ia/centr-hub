import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import {
  PRESENCE_HISTORY_LIMIT,
  PRESENCE_LOOKBACK_DAYS,
  PRESENCE_SESSION_GAP_MINUTES,
} from "@/lib/constants";
import type { ISODateString, UUID } from "@/lib/types/database";

/**
 * Presencia y tramos de uso (0057). Toda función opera DENTRO de
 * `withTenantContext(...)`.
 */

/** Un tramo de uso, tal como lo pinta el historial. */
export interface ActivitySession {
  id: UUID;
  startedAt: ISODateString;
  /** Último latido = fin del tramo (no hay `ended_at`). */
  lastSeenAt: ISODateString;
}

/**
 * Registra el latido. La decisión "extender el tramo vigente vs abrir uno
 * nuevo" vive en el RPC y no aquí: es leer-y-luego-escribir, y dos pestañas
 * de la misma persona latiendo a la vez crearían dos tramos para una sola
 * sesión. El RPC lo serializa con un lock por (org, persona).
 */
export async function recordPresenceHeartbeat(userId: UUID): Promise<void> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { error } = await supabase.rpc("record_user_presence", {
    p_organization_id: organizationId,
    p_user_id: userId,
    p_gap_minutes: PRESENCE_SESSION_GAP_MINUTES,
  });
  if (error) throw error;
}

/**
 * Última señal de vida de cada persona, en lote.
 *
 * Acotado a `PRESENCE_LOOKBACK_DAYS` por diseño: sin cota traería el
 * historial COMPLETO de todas las personas para quedarse con una fila de
 * cada una. Quien no aparezca en la ventana se pinta como "sin actividad
 * reciente" — que es exactamente lo que significa.
 */
export async function listLastSeenByUser(
  userIds: UUID[],
): Promise<Map<UUID, ISODateString>> {
  const out = new Map<UUID, ISODateString>();
  if (userIds.length === 0) return out;
  const { supabase, organizationId } = getTenantScopedClient();
  const since = new Date(
    Date.now() - PRESENCE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data, error } = await supabase
    .from("user_activity_sessions")
    .select("user_id, last_seen_at")
    .eq("organization_id", organizationId)
    .in("user_id", userIds)
    .gte("last_seen_at", since)
    .order("last_seen_at", { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    user_id: UUID;
    last_seen_at: ISODateString;
  }>;
  // Vienen ordenados desc: la PRIMERA de cada persona es la más reciente.
  for (const row of rows) {
    if (!out.has(row.user_id)) out.set(row.user_id, row.last_seen_at);
  }
  return out;
}

/**
 * Historial de tramos de una persona, del más reciente al más viejo.
 * Sin cota de fecha: el historial es justamente lo que se quiere ver hacia
 * atrás, y el límite de filas ya acota el tamaño.
 */
export async function listActivitySessionsForUser(
  userId: UUID,
  limit: number = PRESENCE_HISTORY_LIMIT,
): Promise<ActivitySession[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("user_activity_sessions")
    .select("id, started_at, last_seen_at")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .order("last_seen_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: UUID;
    started_at: ISODateString;
    last_seen_at: ISODateString;
  }>;
  return rows.map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    lastSeenAt: r.last_seen_at,
  }));
}
