import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { getContactById, updateContact } from "@/lib/db/contacts";
import { recordAuditEvent } from "@/lib/db/operational";
import type { ContactRow, Json, UUID } from "@/lib/types/database";

/**
 * Marca (o des-marca) un contacto como outbound y propaga la marca a sus
 * oportunidades NO TERMINALES (Fase 2 de Outbound).
 *
 * Fuente de verdad = `contacts.is_outbound`; las opps llevan copia
 * denormalizada (0040) que el dashboard lee sin joinar contactos.
 *
 * Retroactividad "solo activas y futuras" (decisión del operador): la
 * propagación toca únicamente opps NO terminales (won_at/lost_at/cancelled_at
 * IS NULL). Las cerradas conservan su categoría histórica — no se reescriben
 * métricas ya reportadas. Las opps FUTURAS del contacto nacen marcadas por el
 * birth-stamping (leen `contacts.is_outbound`).
 *
 * Idempotente: si el contacto ya está en el valor pedido, no hace nada.
 *
 * Reversibilidad: `value=false` es la corrección admin (des-marca) — misma
 * mecánica simétrica, audit `contact_outbound_unset`.
 */
export async function setContactOutbound(args: {
  contactId: UUID;
  value: boolean;
  actorUserId: UUID | null;
}): Promise<ContactRow> {
  const { supabase, organizationId } = getTenantScopedClient();

  const contact = await getContactById(args.contactId);
  if (!contact) throw new Error("contact_not_found");
  if (contact.is_outbound === args.value) {
    return contact; // idempotente
  }

  const ts = new Date().toISOString();
  const updated = await updateContact(args.contactId, {
    is_outbound: args.value,
    last_modified_at: ts,
    last_modified_source: "platform",
  });

  // Propagar a opps NO terminales (activas y futuras). won_at/lost_at =
  // terminales reales; cancelled_at = canceladas administrativas — todas
  // conservan su categoría histórica.
  const { error } = await supabase
    .from("opportunities")
    .update({ is_outbound: args.value })
    .eq("organization_id", organizationId)
    .eq("contact_id", args.contactId)
    .is("won_at", null)
    .is("lost_at", null)
    .is("cancelled_at", null);
  if (error) throw error;

  await recordAuditEvent({
    actorUserId: args.actorUserId,
    eventType: args.value ? "contact_marked_outbound" : "contact_outbound_unset",
    entityType: "contact",
    entityId: args.contactId,
    payload: { is_outbound: args.value } as Json,
  });

  return updated;
}
