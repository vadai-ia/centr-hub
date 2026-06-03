import "server-only";
import { findOrdersWithTag, reattributeOrders } from "@/lib/db/tag-aggregation";
import { recordAuditEvent } from "@/lib/db/operational";
import type { UUID } from "@/lib/types/database";

/**
 * Re-procesamiento retroactivo de atribución por tag (M7.2, Bloque 5).
 *
 * ALCANCE: re-atribuye las ÓRDENES que llevan la tag (unidad de
 * atribución de revenue — ver `orders.ts`) al vendedor mapeado, y
 * cascadea al `opportunity_id` ligado. NO toca contactos (cuya
 * asignación pertenece al dominio Whaapy, no a tags de venta). Se
 * dispara solo cuando el admin reclasifica una tag a `vendor` o
 * cambia el vendedor mapeado.
 *
 * Compartido por el path inline (conteo pequeño) y el worker Inngest
 * (conteo grande, background). Idempotente: re-correr fija el mismo
 * `assigned_advisor_id`.
 */

export interface RunTagReprocessingInput {
  normalizedTag: string;
  membershipId: UUID | null;
  /** Quién lo disparó — para el audit log. */
  actorUserId: UUID | null;
}

export async function runTagReprocessing(
  input: RunTagReprocessingInput,
): Promise<number> {
  const orders = await findOrdersWithTag(input.normalizedTag);
  const affected = await reattributeOrders(orders, input.membershipId);
  await recordAuditEvent({
    actorUserId: input.actorUserId,
    eventType: "tag_attribution_reprocessed",
    entityType: "tag_mapping",
    entityId: null,
    payload: {
      normalized_tag: input.normalizedTag,
      mapped_membership_id: input.membershipId,
      affected_entities: affected,
    },
  });
  return affected;
}
