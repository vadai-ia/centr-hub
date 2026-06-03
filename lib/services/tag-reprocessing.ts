import "server-only";
import {
  findContactsWithTag,
  findOrdersWithTag,
  reattributeContacts,
  reattributeOrders,
} from "@/lib/db/tag-aggregation";
import { recordAuditEvent } from "@/lib/db/operational";
import type { UUID } from "@/lib/types/database";

/**
 * Re-procesamiento retroactivo de atribución por tag (M7.2, Bloque 5).
 *
 * ALCANCE: re-atribuye al vendedor mapeado (a) las ÓRDENES que llevan
 * la tag (unidad de atribución de revenue — ver `orders.ts`) + cascada
 * a su `opportunity_id` ligado, y (b) los CONTACTOS que llevan la tag,
 * LWW-aware (fix post-CHECKPOINT M7.2 #3 — la tag de Shopify es fuente
 * legítima de asignación del contacto, R2; respeta asignaciones Whaapy
 * más recientes). Se dispara cuando el admin reclasifica una tag a
 * `vendor` o cambia el vendedor mapeado.
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
  const [orders, contacts] = await Promise.all([
    findOrdersWithTag(input.normalizedTag),
    findContactsWithTag(input.normalizedTag),
  ]);
  const ordersAffected = await reattributeOrders(orders, input.membershipId);
  const contactsAffected = await reattributeContacts(contacts, input.membershipId);
  const affected = ordersAffected + contactsAffected;
  await recordAuditEvent({
    actorUserId: input.actorUserId,
    eventType: "tag_attribution_reprocessed",
    entityType: "tag_mapping",
    entityId: null,
    payload: {
      normalized_tag: input.normalizedTag,
      mapped_membership_id: input.membershipId,
      affected_entities: affected,
      orders_affected: ordersAffected,
      contacts_affected: contactsAffected,
    },
  });
  return affected;
}
