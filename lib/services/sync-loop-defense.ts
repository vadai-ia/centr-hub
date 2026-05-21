import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { requireTenantContext } from "@/lib/tenant/context";
import { recordAuditEvent } from "@/lib/db/operational";
import { PLATFORM_ORIGIN_MARKER } from "@/lib/constants";
import type { UUID } from "@/lib/types/database";

/**
 * Defensa anti-bucle R11 (CLAUDE.md "Defensa anti-bucle" — opción B).
 *
 * Mecánica adoptada:
 *   - Toda escritura outbound a Shopify (PUT customer, add/remove
 *     tag, POST customer) actualiza el contact local con:
 *       last_modified_at    = NOW()
 *       last_modified_source = 'platform'
 *   - Cuando llega webhook `customers/update` desde Shopify, M3
 *     compara `payload.updated_at` con `contact.last_modified_at`
 *     dentro de un margen pequeño (ECHO_WINDOW_MS).
 *     - Si están dentro del margen Y `last_modified_source = 'platform'`
 *       → es eco de nuestra propia escritura → descarta + audit log
 *       `sync_loop_prevented`.
 *
 * Por qué no opción A (metafield/note custom):
 *   - El webhook `customers/update` REST NO incluye metafields a
 *     menos que se haga una request adicional. Opción B con marker
 *     de timestamp + source es suficiente y no agrega round-trips.
 *
 * Llamadas outbound deben SIEMPRE marcar el contact local antes
 * (o como parte de la transacción) para no perder el rastro si
 * Shopify procesa rápido.
 */

const ECHO_WINDOW_MS = 30_000; // 30s — Shopify suele entregar en <5s

export interface OutboundMarkInput {
  contactId: UUID;
  source: typeof PLATFORM_ORIGIN_MARKER;
  /** Optional: usar timestamp específico (testing); default NOW(). */
  at?: Date;
}

export async function markOutboundWrite(input: OutboundMarkInput): Promise<void> {
  const { supabase, organizationId } = getTenantScopedClient();
  const at = (input.at ?? new Date()).toISOString();
  const { error } = await supabase
    .from("contacts")
    .update({
      last_modified_at: at,
      last_modified_source: "platform",
    })
    .eq("id", input.contactId)
    .eq("organization_id", organizationId);
  if (error) throw error;
}

export interface LoopCheckInput {
  contactId: UUID;
  payloadUpdatedAt: string | null;
}

export interface LoopCheckResult {
  isOwnEcho: boolean;
  reason: "no_local_record" | "marker_mismatch" | "outside_window" | "own_echo_detected";
}

export async function checkInboundIsOwnEcho(
  input: LoopCheckInput,
): Promise<LoopCheckResult> {
  requireTenantContext();
  if (!input.payloadUpdatedAt) {
    return { isOwnEcho: false, reason: "marker_mismatch" };
  }
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("last_modified_at, last_modified_source")
    .eq("id", input.contactId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { isOwnEcho: false, reason: "no_local_record" };

  const source = data.last_modified_source as string;
  if (source !== "platform") {
    return { isOwnEcho: false, reason: "marker_mismatch" };
  }

  const localTs = new Date(data.last_modified_at as string).getTime();
  const payloadTs = new Date(input.payloadUpdatedAt).getTime();
  const delta = Math.abs(payloadTs - localTs);
  if (delta > ECHO_WINDOW_MS) {
    return { isOwnEcho: false, reason: "outside_window" };
  }
  return { isOwnEcho: true, reason: "own_echo_detected" };
}

/**
 * Conveniencia: si es eco propio, registra audit y retorna true
 * para que el caller corte el flujo. Si no, retorna false y el
 * caller sigue procesando.
 */
export async function discardIfOwnEcho(input: {
  contactId: UUID;
  payloadUpdatedAt: string | null;
  source: "shopify" | "whaapy";
  shopifyEntityId?: string | null;
  whaapyEntityId?: string | null;
}): Promise<boolean> {
  const result = await checkInboundIsOwnEcho({
    contactId: input.contactId,
    payloadUpdatedAt: input.payloadUpdatedAt,
  });
  if (!result.isOwnEcho) return false;
  await recordAuditEvent({
    actorUserId: null,
    eventType: "sync_loop_prevented",
    entityType: "contact",
    entityId: input.contactId,
    payload: {
      source: input.source,
      shopify_entity_id: input.shopifyEntityId ?? null,
      whaapy_entity_id: input.whaapyEntityId ?? null,
      reason: result.reason,
    },
  });
  return true;
}
