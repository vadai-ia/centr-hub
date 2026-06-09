import "server-only";
import { listPipelineStages } from "@/lib/db/pipeline";
import { listOpportunities, cancelOpportunity } from "@/lib/db/opportunities";
import { updateContact } from "@/lib/db/contacts";
import { getOrganizationById } from "@/lib/db/organizations";
import { updateCustomerTags, BackfillSuppressedError } from "@/lib/shopify/outbound";
import { recordAuditEvent } from "@/lib/db/operational";
import { WHAAPY_DELETED_SHOPIFY_TAG } from "@/lib/constants";
import type { ContactRow, Json, OpportunityRow, UUID } from "@/lib/types/database";

/**
 * Archivado propagado por borrado en Whaapy (Fix A).
 *
 * Un contacto borrado en Whaapy se ARCHIVA en la plataforma (nunca
 * borrado físico — doctrina). El archivado propaga en tres frentes:
 *
 *   1. Contacto → `deleted_in_whaapy = true` (marca + metadata). El
 *      `whaapy_contact_id` se CONSERVA (trazabilidad + dedup; la
 *      doctrina no borra identificadores externos). La UI deriva el
 *      badge de presencia a partir de `whaapy_contact_id && !deleted_in_whaapy`,
 *      así "WHAAPY" y "Eliminado en Whaapy" dejan de convivir.
 *   2. Oportunidades NO terminales → canceladas vía `cancelOpportunity`
 *      (mecanismo de mig. 0014: preserva etapa, NO toca win-rate, NO
 *      escribe en stage_history). Las terminales (Ganada/Perdida) se
 *      PRESERVAN — son historia comercial real; cancelarlas la
 *      reescribiría. "Terminal" se resuelve por las flags de etapa
 *      (`is_won || is_lost`), autoritativas sobre `won_at`/`lost_at`.
 *   3. Shopify → si el contacto tiene `shopify_customer_id`, se ETIQUETA
 *      el customer con `WHAAPY_DELETED_SHOPIFY_TAG` (no se borra). La
 *      escritura lleva marca R11 (dentro de `updateCustomerTags`).
 *
 * Idempotente: re-procesar el mismo borrado no duplica ni corrompe —
 * `cancelOpportunity` preserva el primer `cancelled_at`, el tag se
 * de-duplica, y la marca del contacto es un set determinista.
 *
 * Reusado por el worker `whaapyContactDeleted` (M4) y por el correctivo
 * `scripts/maintenance/archive-whaapy-deleted-contacts.ts`, con
 * semántica idéntica. `dryRun` calcula el plan sin escribir.
 */

export type ArchivalSource = "whaapy_webhook" | "corrective_backfill";

export interface ArchiveContactInput {
  contact: ContactRow;
  /** Timestamp del borrado (payload Whaapy o now()). */
  deletedAt: string;
  /** Distingue worker vs correctivo en el audit log. */
  source: ArchivalSource;
  /** Si true, NO escribe — solo reporta qué haría. */
  dryRun?: boolean;
}

export interface ArchiveContactResult {
  contactId: UUID;
  /** Ya estaba archivado al entrar (deleted_in_whaapy ya era true). */
  alreadyArchived: boolean;
  /** Opps que se cancelaron (o se cancelarían en dry-run). */
  cancelledOpportunityIds: UUID[];
  /** Opps terminales preservadas (Ganada/Perdida). */
  preservedTerminalOpportunityIds: UUID[];
  /** True si se etiquetó (o se etiquetaría) el customer Shopify. */
  shopifyTagged: boolean;
  /** Razón si NO se etiquetó pese a tener shopify_customer_id. */
  shopifySkipReason: string | null;
}

export async function archiveContactForWhaapyDeletion(
  input: ArchiveContactInput,
): Promise<ArchiveContactResult> {
  const { contact, deletedAt, source, dryRun = false } = input;

  // 1. Resolver etapas terminales (is_won || is_lost) de ambos funnels.
  const stages = await listPipelineStages();
  const terminalStageIds = new Set(
    stages.filter((s) => s.is_won || s.is_lost).map((s) => s.id),
  );

  // 2. Opps activas (cancelled_at IS NULL) del contacto en cualquier
  //    funnel. Se cancelan las que NO estén en etapa terminal.
  const activeOpps = await listOpportunities({ contactId: contact.id });
  const toCancel: OpportunityRow[] = [];
  const preserved: OpportunityRow[] = [];
  for (const opp of activeOpps) {
    if (terminalStageIds.has(opp.stage_id)) preserved.push(opp);
    else toCancel.push(opp);
  }

  const cancelledOpportunityIds: UUID[] = [];
  if (!dryRun) {
    for (const opp of toCancel) {
      const { opportunity } = await cancelOpportunity({
        opportunityId: opp.id,
        source: "whaapy_contact_deleted",
        note: "Contacto borrado en Whaapy — lead archivado",
        cancelledAt: deletedAt,
      });
      cancelledOpportunityIds.push(opportunity.id);
    }
  } else {
    cancelledOpportunityIds.push(...toCancel.map((o) => o.id));
  }

  // 3. Reflejo en Shopify — etiquetar (no borrar). Side-effect: un
  //    fallo NO bloquea el archivado local (el maestro queda correcto).
  let shopifyTagged = false;
  let shopifySkipReason: string | null = null;
  if (!contact.shopify_customer_id) {
    shopifySkipReason = "no_shopify_identity";
  } else {
    const alreadyTagged = (contact.shopify_tags ?? []).some(
      (t) => t.trim().toLowerCase() === WHAAPY_DELETED_SHOPIFY_TAG.toLowerCase(),
    );
    if (alreadyTagged) {
      shopifySkipReason = "tag_already_present";
    } else if (dryRun) {
      shopifyTagged = true; // lo etiquetaría
    } else {
      try {
        const org = await getOrganizationById(contact.organization_id);
        const shopDomain = org?.shopify_store_domain ?? null;
        if (!shopDomain) {
          shopifySkipReason = "no_shop_domain";
        } else {
          await updateCustomerTags({
            ctx: { organizationId: contact.organization_id, shopDomain },
            contactId: contact.id,
            shopifyCustomerId: contact.shopify_customer_id,
            currentTags: contact.shopify_tags ?? [],
            tagsToAdd: [WHAAPY_DELETED_SHOPIFY_TAG],
          });
          shopifyTagged = true;
        }
      } catch (err) {
        shopifySkipReason =
          err instanceof BackfillSuppressedError
            ? "backfill_suppressed"
            : (err as Error).message;
        await recordAuditEvent({
          actorUserId: null,
          eventType: "shopify_archive_tag_from_whaapy_failed",
          entityType: "contact",
          entityId: contact.id,
          payload: {
            shopify_customer_id: contact.shopify_customer_id,
            error: (err as Error).message,
          } as Json,
        });
      }
    }
  }

  // 4. Marca de archivado en el maestro + audit (al final, para que el
  //    flag refleje el estado tras la propagación). Idempotente.
  const alreadyArchived = contact.deleted_in_whaapy === true;
  if (!dryRun) {
    await updateContact(contact.id, {
      deleted_in_whaapy: true,
      last_modified_at: deletedAt,
      last_modified_source: "whaapy",
    });
    await recordAuditEvent({
      actorUserId: null,
      eventType: "contact_archived_whaapy_deletion",
      entityType: "contact",
      entityId: contact.id,
      payload: {
        source,
        whaapy_contact_id: contact.whaapy_contact_id,
        already_archived: alreadyArchived,
        cancelled_opportunity_ids: cancelledOpportunityIds,
        preserved_terminal_opportunity_ids: preserved.map((o) => o.id),
        shopify_tagged: shopifyTagged,
        shopify_skip_reason: shopifySkipReason,
      } as Json,
    });
  }

  return {
    contactId: contact.id,
    alreadyArchived,
    cancelledOpportunityIds,
    preservedTerminalOpportunityIds: preserved.map((o) => o.id),
    shopifyTagged,
    shopifySkipReason,
  };
}
