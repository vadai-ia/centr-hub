import "server-only";
import { getInngestClient } from "@/lib/inngest/client";
import { withTenantContext } from "@/lib/tenant/context";
import { createNotification } from "@/lib/db/operational";
import { runTagReprocessing } from "@/lib/services/tag-reprocessing";
import type { UUID } from "@/lib/types/database";

/**
 * Worker de re-procesamiento retroactivo de tags en background (M7.2,
 * Bloque 5). Se dispara cuando el conteo de entidades supera el umbral
 * inline; al terminar notifica al admin que lo solicitó.
 */

export const PLATFORM_TAG_REPROCESS_EVENT = "platform/tag.reprocess_requested" as const;

export interface TagReprocessEnvelope {
  organizationId: UUID;
  normalizedTag: string;
  originalTag: string;
  membershipId: UUID | null;
  actorUserId: UUID | null;
}

const inngest = getInngestClient();

export const tagReprocess = inngest.createFunction(
  {
    id: "platform-tag-reprocess",
    retries: 3,
    triggers: [{ event: PLATFORM_TAG_REPROCESS_EVENT }],
  },
  async ({ event }) => {
    const data = event.data as unknown as TagReprocessEnvelope;
    return withTenantContext(
      data.organizationId,
      async () => {
        const affected = await runTagReprocessing({
          normalizedTag: data.normalizedTag,
          membershipId: data.membershipId,
          actorUserId: data.actorUserId,
        });
        if (data.actorUserId) {
          await createNotification({
            user_id: data.actorUserId,
            notification_type: "tag_reprocess_completed",
            origin: "system",
            origin_reference: {
              normalized_tag: data.normalizedTag,
              affected_entities: affected,
            },
            opportunity_id: null,
            contact_id: null,
            title: "Re-procesamiento de tag completado",
            message: `La tag "${data.originalTag}" re-atribuyó ${affected} entidad${affected === 1 ? "" : "es"}.`,
            amount_at_stake: null,
            due_at: null,
            status: "pending",
            snoozed_until: null,
            schema_version: "1",
            completed_at: null,
          });
        }
        return { affected };
      },
      { source: "worker" },
    );
  },
);

export const tagReprocessFunctions = [tagReprocess];
