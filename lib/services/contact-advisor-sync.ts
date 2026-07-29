import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { getContactById, updateContact } from "@/lib/db/contacts";
import { listTagMappings } from "@/lib/db/configuration";
import { getOrganizationById } from "@/lib/db/organizations";
import { recordAuditEvent } from "@/lib/db/operational";
import { updateCustomerTags } from "@/lib/shopify/outbound";
import { recordWhaapySyncIntent } from "@/lib/inngest/functions/customers";
import type { ContactRow, Json, UUID } from "@/lib/types/database";

/**
 * Sincronización del ASESOR-DUEÑO del contacto (Venta) desde la oportunidad.
 *
 * Modelo (aprobado): el asesor propio del contacto = dueño de VENTA, y es lo
 * único que se propaga a Whaapy (agente) + Shopify (tag de vendedor). Asignar
 * un asesor en una opp de **Venta** materializa ese dueño en el contacto; una
 * asignación de **Post-venta** NO lo toca (un contacto puede tener vendedor en
 * Venta y Customer Success en Post-venta a la vez).
 *
 * Reglas del recompute (decisiones del operador):
 *   - Se computa desde las opps de Venta ACTIVAS del contacto: `cancelled_at
 *     IS NULL AND lost_at IS NULL` → las Ganadas SÍ cuentan (el vendedor que
 *     ganó sigue siendo dueño); Perdidas/Canceladas NO.
 *   - 1 asesor distinto → ese. 0 → sin asesor (desasigna). >1 (conflicto) →
 *     gana el asesor recién asignado (explicit-wins); si el disparo fue una
 *     DESASIGNACIÓN dentro de un conflicto, se conserva el dueño actual.
 *   - Solo se propaga cuando cambia (idempotente).
 *
 * R2: esto es la ÚNICA vía por la que una reasignación MANUAL de opp de Venta
 * mueve el dueño del contacto. Las atribuciones AUTOMÁTICAS (tag/orden/
 * reconciliación) NO llaman aquí — el asesor gana sobre el tag de Shopify y
 * dejar que el tag reescriba el dueño de mensajería invertiría esa regla.
 */

/** Decisión PURA del nuevo dueño-Venta del contacto. Testeable sin BD. */
export function computeVentaContactOwner(opts: {
  /** Asesores de las opps de Venta activas del contacto (Ganadas sí, Perdidas
   *  /Canceladas ya excluidas por el query), DESPUÉS del cambio. */
  ventaAdvisorIds: (UUID | null)[];
  /** Asesor recién puesto en la opp que disparó esto (null = desasignación). */
  justAssignedAdvisorId: UUID | null;
  /** Dueño actual del contacto. */
  currentOwnerId: UUID | null;
}): UUID | null {
  const distinct = Array.from(
    new Set(opts.ventaAdvisorIds.filter((x): x is UUID => x != null)),
  );
  if (distinct.length === 1) return distinct[0];
  if (distinct.length === 0) return null;
  // Conflicto (>1): explicit-wins; en una desasignación hacia el conflicto,
  // no adivinamos → se conserva el dueño actual.
  return opts.justAssignedAdvisorId ?? opts.currentOwnerId;
}

/**
 * Recalcula y materializa el dueño-Venta del contacto tras una reasignación
 * MANUAL de una opp de Venta, y propaga el cambio (Whaapy + Shopify) si el
 * dueño cambió. Best-effort: el caller la envuelve para no revertir la
 * reasignación de la opp si esto falla (es derivado y re-disparable).
 * Debe correr DENTRO de un `withTenantContext`.
 */
export async function syncVentaContactOwnerFromOpp(opts: {
  contactId: UUID;
  justAssignedAdvisorId: UUID | null;
  actorUserId: UUID | null;
}): Promise<void> {
  const contact = await getContactById(opts.contactId);
  if (!contact) return;

  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("assigned_advisor_id")
    .eq("organization_id", organizationId)
    .eq("contact_id", opts.contactId)
    .eq("funnel", "venta")
    .is("cancelled_at", null)
    .is("lost_at", null);
  if (error) throw error;
  const ventaAdvisorIds = ((data ?? []) as Array<{ assigned_advisor_id: UUID | null }>)
    .map((r) => r.assigned_advisor_id);

  const previous = contact.assigned_advisor_id;
  const newOwner = computeVentaContactOwner({
    ventaAdvisorIds,
    justAssignedAdvisorId: opts.justAssignedAdvisorId,
    currentOwnerId: previous,
  });
  if (newOwner === previous) return; // sin cambio → no propaga

  const conflict =
    new Set(ventaAdvisorIds.filter((x) => x != null)).size > 1;
  const updated = await updateContact(opts.contactId, {
    assigned_advisor_id: newOwner,
    last_modified_at: new Date().toISOString(),
    last_modified_source: "platform",
  });
  await recordAuditEvent({
    actorUserId: opts.actorUserId,
    eventType: "contact_owner_synced_from_opp",
    entityType: "contact",
    entityId: opts.contactId,
    payload: {
      from_membership_id: previous,
      to_membership_id: newOwner,
      conflict,
    } as Json,
  });
  await propagateContactAdvisorChange(updated, previous);
}

/**
 * Propaga un cambio de asesor-dueño del contacto a los espejos:
 *   - Shopify: tag de vendedor (add nuevo / remove viejo). SÍNCRONO pero
 *     early-return si el contacto no es customer Shopify (los leads salen sin
 *     llamada) → en un burst de desactivación casi todos son leads.
 *   - Whaapy: `recordWhaapySyncIntent` (ASÍNCRONO vía Inngest, con throttle en
 *     el worker) → un burst de reasignaciones no golpea el rate limit de
 *     Whaapy de golpe.
 * Compartido por la reasignación a nivel CONTACTO (contacts.ts) y por
 * `syncVentaContactOwnerFromOpp`. Best-effort: cada fallo se audita sin
 * afectar la transacción principal (el cambio local ya persistió).
 */
export async function propagateContactAdvisorChange(
  contact: ContactRow,
  previousMembershipId: UUID | null,
): Promise<void> {
  // Shopify: tags de vendedor.
  if (contact.shopify_customer_id) {
    try {
      const org = await getOrganizationById(contact.organization_id);
      const shopDomain = org?.shopify_store_domain;
      if (shopDomain) {
        const vendorTagsByMembership = await loadVendorTagsByMembership();
        const newTag = contact.assigned_advisor_id
          ? vendorTagsByMembership.get(contact.assigned_advisor_id) ?? null
          : null;
        const oldTag = previousMembershipId
          ? vendorTagsByMembership.get(previousMembershipId) ?? null
          : null;
        const tagsToAdd = newTag ? [newTag] : [];
        const tagsToRemove = oldTag && oldTag !== newTag ? [oldTag] : [];
        if (tagsToAdd.length > 0 || tagsToRemove.length > 0) {
          await updateCustomerTags({
            ctx: { organizationId: contact.organization_id, shopDomain },
            contactId: contact.id,
            shopifyCustomerId: contact.shopify_customer_id,
            currentTags: contact.shopify_tags,
            tagsToAdd,
            tagsToRemove,
          });
        }
      }
    } catch (e) {
      await recordAuditEvent({
        actorUserId: null,
        eventType: "contact_reassignment_shopify_tag_failed",
        entityType: "contact",
        entityId: contact.id,
        payload: { error: e instanceof Error ? e.message : "unknown" } as Json,
      });
    }
  }

  // Whaapy: evento Inngest (throttled en el worker).
  if (contact.whaapy_contact_id) {
    try {
      await recordWhaapySyncIntent(contact, "update_from_platform_ui");
    } catch (e) {
      await recordAuditEvent({
        actorUserId: null,
        eventType: "contact_reassignment_whaapy_dispatch_failed",
        entityType: "contact",
        entityId: contact.id,
        payload: { error: e instanceof Error ? e.message : "unknown" } as Json,
      });
    }
  }
}

async function loadVendorTagsByMembership(): Promise<Map<UUID, string>> {
  const mappings = await listTagMappings({ classification: "vendor" });
  const out = new Map<UUID, string>();
  for (const m of mappings) {
    if (m.mapped_membership_id) {
      out.set(m.mapped_membership_id, m.original_tag);
    }
  }
  return out;
}
