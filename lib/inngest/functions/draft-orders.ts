import "server-only";
import {
  getInngestClient,
  type ShopifyWebhookEnvelope,
} from "@/lib/inngest/client";
import { runWebhookWorker } from "@/lib/inngest/helpers";
import {
  mapDraftOrderWebhookToNormalized,
  type NormalizedDraftOrder,
} from "@/lib/shopify/mappers";
import { parseShopifyTags } from "@/lib/services/tag-parser";
import { matchContactIdentity } from "@/lib/services/identity-matching";
import { shouldApplyRecordUpdate } from "@/lib/services/last-write-wins";
import { hydrateContactFromEmbeddedShopifyCustomer } from "@/lib/inngest/functions/customers";
import {
  createContact,
  findContactByShopifyCustomerId,
} from "@/lib/db/contacts";
import { listPipelineStages } from "@/lib/db/pipeline";
import {
  cancelOpportunity,
  createOpportunity,
  findOpportunityByDraftOrderId,
  recordStageChange,
  replaceLineItems,
  updateOpportunity,
} from "@/lib/db/opportunities";
import { absorbInitialStageOpportunities } from "@/lib/services/opportunity-absorption";
import { fireF1ToF2Trigger } from "@/lib/services/f1-to-f2-trigger";
import { recordAuditEvent } from "@/lib/db/operational";
import type {
  ContactRow,
  Json,
  PipelineStageRow,
  UUID,
} from "@/lib/types/database";

/**
 * Workers de Draft Orders → oportunidades Funnel Venta.
 *
 * Topics:
 *   - draft_orders/create → crea oportunidad en etapa "Cotización".
 *   - draft_orders/update → LWW por registro + reemplaza line items.
 *   - draft_orders/delete → marca oportunidad como cancelada
 *                            (conserva histórico — Sección 3.3.4).
 *
 * Etapa "Cotización" (v5.1, posición 6) viene del bootstrap de
 * pipeline_stages — el worker la resuelve dinámicamente por nombre
 * para tolerar reordenamiento por admin.
 */

const inngest = getInngestClient();
const COTIZACION_STAGE_NAME = "Cotización";

/**
 * Un Draft Order está completado cuando Shopify pone `status` en
 * "completed" (o equivalentemente cuando aparece `completed_at`). Es
 * el disparador del trigger atómico F1→F2 (M7.2, Bloque 2).
 */
function isDraftCompleted(normalized: NormalizedDraftOrder): boolean {
  return normalized.status === "completed" || normalized.completedAt !== null;
}

/**
 * Dispara el trigger F1→F2 si el draft se completó. Idempotente
 * (el RPC `trigger_f1_to_f2` detecta hija existente), así que es
 * seguro invocarlo desde cualquier path que resuelva la oportunidad.
 */
async function maybeFireF1ToF2(
  opportunityId: UUID,
  normalized: NormalizedDraftOrder,
  shopifyEventId: string,
): Promise<void> {
  if (!isDraftCompleted(normalized)) return;
  await fireF1ToF2Trigger({
    opportunityId,
    shopifyOrderId: normalized.shopifyOrderId,
    shopifyEventId,
  });
}

async function resolveCotizacionStage(): Promise<PipelineStageRow> {
  const stages = await listPipelineStages("venta");
  const stage = stages.find((s) => s.name === COTIZACION_STAGE_NAME);
  if (!stage) {
    throw new Error(
      `draft_orders worker: no se encontró etapa "${COTIZACION_STAGE_NAME}" en Funnel Venta`,
    );
  }
  return stage;
}

async function resolveOrCreateContactForDraftOrder(
  normalized: NormalizedDraftOrder,
  effectiveUpdatedAt: string,
): Promise<ContactRow | null> {
  if (!normalized.shopifyCustomerId) return null;
  const existing = await findContactByShopifyCustomerId(normalized.shopifyCustomerId);
  if (existing) return existing;

  // Fix M3 (ver ERRORES.md): el payload de draft_orders/* trae el
  // OBJETO customer completo. Si el DO llega antes que customers/*,
  // hidratamos el contacto con los datos del payload en vez de un
  // stub vacío. El helper aplica identity match por phone/email +
  // LWW por campo (mismo flujo que customers/create).
  if (normalized.embeddedCustomer) {
    const customerUpdatedAt =
      normalized.embeddedCustomer.updatedAt
      ?? normalized.embeddedCustomer.createdAt
      ?? effectiveUpdatedAt;
    return await hydrateContactFromEmbeddedShopifyCustomer(
      normalized.embeddedCustomer,
      customerUpdatedAt,
    );
  }

  // Fallback defensivo: customer.id presente pero objeto sin datos.
  // Same path antiguo: identity match por id + stub vacío.
  const match = await matchContactIdentity({
    source: "shopify",
    shopifyCustomerId: normalized.shopifyCustomerId,
  });
  if (match.match) {
    return match.match;
  }
  return await createContact({
    full_name: null,
    email: null,
    phone: null,
    address: null,
    internal_note: null,
    shopify_state: null,
    shopify_tags: [],
    assigned_advisor_id: null,
    shopify_customer_id: normalized.shopifyCustomerId,
    whaapy_contact_id: null,
    missing_phone: true,
    field_metadata: {} as Json,
    last_modified_at: effectiveUpdatedAt,
    last_modified_source: "shopify",
    deleted_in_shopify: false,
    deleted_in_whaapy: false,
    anonymized_at: null,
    last_whaapy_activity_at: null,
  });
}

async function resolveTagAssignment(
  normalized: NormalizedDraftOrder,
): Promise<UUID | null> {
  const result = await parseShopifyTags({
    rawTags: normalized.tags,
    source: "draft_order",
    shopifyEntityId: normalized.shopifyDraftOrderId,
  });
  return result.assignedMembership?.id ?? null;
}

// ============================================================
// 1) draft_orders/create
// ============================================================

export const draftOrdersCreate = inngest.createFunction(
  {
    id: "shopify-draft-orders-create",
    retries: 5,
    triggers: [{ event: "shopify/draft_orders.create" }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as ShopifyWebhookEnvelope;
    return runWebhookWorker(envelope, "draft_orders/create", async (env) => {
      const normalized = mapDraftOrderWebhookToNormalized(env.payload);
      const effectiveUpdatedAt =
        normalized.updatedAt ?? normalized.createdAt ?? new Date().toISOString();

      const contact = await resolveOrCreateContactForDraftOrder(
        normalized,
        effectiveUpdatedAt,
      );
      if (!contact) {
        await recordAuditEvent({
          actorUserId: null,
          eventType: "draft_order_without_customer_ignored",
          entityType: "draft_order",
          entityId: null,
          payload: { shopify_draft_order_id: normalized.shopifyDraftOrderId },
        });
        return { discarded: true, reason: "no_customer" };
      }

      // Idempotencia
      const existing = await findOpportunityByDraftOrderId(normalized.shopifyDraftOrderId);
      const stage = await resolveCotizacionStage();
      const tagAssignment = await resolveTagAssignment(normalized);

      if (existing) {
        // Tratar como update.
        if (!shouldApplyRecordUpdate(existing.last_modified_at, effectiveUpdatedAt)) {
          return { opportunityId: existing.id, discarded: true, reason: "stale_update" };
        }
        const patch = buildOpportunityPatchFromDraftOrder(normalized, effectiveUpdatedAt);
        if (tagAssignment) patch.assigned_advisor_id = tagAssignment;
        await updateOpportunity(existing.id, patch);
        await replaceLineItems(existing.id, normalized.lineItems.map(mapLineItemForOpportunity));
        // Defensa: un draft que se crea ya completado (caso atípico)
        // dispara el trigger F1→F2 igual. Idempotente.
        await maybeFireF1ToF2(existing.id, normalized, env.eventId);
        return { opportunityId: existing.id, created: false };
      }

      const opp = await createOpportunity(
        buildOpportunityInsertFromDraftOrder({
          normalized,
          stageId: stage.id,
          contactId: contact.id,
          // Regla de prioridad opp>contacto: la opp toma el asesor del TAG
          // del draft, o queda NULL — NUNCA hereda el asesor HISTÓRICO del
          // contacto (que es ruido de pedidos viejos). El asesor real lo
          // rellena la orden vía el hook 0023 (solo NULL). R12 (lead sin
          // draft) sí hereda del contacto — ahí el contacto es el dueño
          // actual; este cambio es acotado al path de draft. Ver ERRORES.md.
          assignedAdvisorId: tagAssignment ?? null,
          isOutbound: contact.is_outbound,
          effectiveUpdatedAt,
        }),
      );
      await recordStageChange({
        opportunityId: opp.id,
        fromStageId: null,
        toStageId: stage.id,
        changedByUserId: null,
        context: "webhook",
        // Entrada a "Cotización" generada por Shopify → su fecha real
        // es la de creación del Draft Order, no now() (migración 0025).
        shopifyEventAt: normalized.createdAt,
      });
      await replaceLineItems(opp.id, normalized.lineItems.map(mapLineItemForOpportunity));
      // Absorbe cualquier "Lead nuevo" R12-creado activo del mismo
      // contacto — cubre la dirección de race en que R12 disparó antes
      // que llegara este draft_orders/create. Ver CLAUDE.md "Auto-creación
      // C2 — Modelo C2 (R12)" + ERRORES.md "Lead nuevo duplicado con
      // Cotización activa por race de webhooks".
      await absorbInitialStageOpportunities({
        contactId: contact.id,
        absorbingOpportunityId: opp.id,
        trigger: "draft_orders_create",
      });
      await maybeFireF1ToF2(opp.id, normalized, env.eventId);
      return { opportunityId: opp.id, created: true };
    });
  },
);

function buildOpportunityInsertFromDraftOrder(args: {
  normalized: NormalizedDraftOrder;
  stageId: UUID;
  contactId: UUID;
  assignedAdvisorId: UUID | null;
  // Marca outbound denormalizada del contacto (0040 — birth-stamping). Una
  // Cotización de un contacto ya outbound nace marcada; en Fase 1 es false.
  isOutbound: boolean;
  effectiveUpdatedAt: string;
}): Parameters<typeof createOpportunity>[0] {
  return {
    funnel: "venta",
    stage_id: args.stageId,
    contact_id: args.contactId,
    assigned_advisor_id: args.assignedAdvisorId,
    is_outbound: args.isOutbound,
    parent_opportunity_id: null,
    shopify_draft_order_id: args.normalized.shopifyDraftOrderId,
    shopify_order_id: null,
    // Fecha real de creación de la Cotización en Shopify (created_at del
    // Draft Order). El dashboard ubica la opp por esta fecha, no por
    // created_at de BD (migración 0025). El mapper ya la extrae.
    shopify_created_at: args.normalized.createdAt,
    display_reference: args.normalized.displayReference,
    actual_amount: args.normalized.totalAmount,
    estimated_amount: null,
    currency: args.normalized.currency,
    probability_override: null,
    weighted_amount: null,
    loss_reason_id: null,
    invoice_url: args.normalized.invoiceUrl,
    note: args.normalized.note,
    shipping_address: (args.normalized.shippingAddress ?? null) as Json | null,
    last_modified_at: args.effectiveUpdatedAt,
    last_modified_source: "shopify",
    won_at: null,
    lost_at: null,
    invoice_sent_at: null,
    cancelled_at: null,
    cancellation_source: null,
    cancellation_note: null,
  };
}

function buildOpportunityPatchFromDraftOrder(
  normalized: NormalizedDraftOrder,
  effectiveUpdatedAt: string,
): Record<string, unknown> {
  return {
    actual_amount: normalized.totalAmount,
    currency: normalized.currency,
    display_reference: normalized.displayReference,
    invoice_url: normalized.invoiceUrl,
    note: normalized.note,
    shipping_address: (normalized.shippingAddress ?? null) as Json | null,
    last_modified_at: effectiveUpdatedAt,
    last_modified_source: "shopify",
  };
}

function mapLineItemForOpportunity(li: NormalizedDraftOrder["lineItems"][number]) {
  return {
    shopify_product_id: li.shopifyProductId,
    shopify_variant_id: li.shopifyVariantId,
    title: li.title,
    sku: li.sku,
    quantity: li.quantity,
    variant_title: li.variantTitle,
    original_unit_price: li.originalUnitPrice,
    discount_amount: li.discountAmount,
    final_price: li.finalPrice,
    weight_grams: li.weightGrams,
    taxable: li.taxable,
  };
}

// ============================================================
// 2) draft_orders/update
// ============================================================

export const draftOrdersUpdate = inngest.createFunction(
  {
    id: "shopify-draft-orders-update",
    retries: 5,
    triggers: [{ event: "shopify/draft_orders.update" }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as ShopifyWebhookEnvelope;
    return runWebhookWorker(envelope, "draft_orders/update", async (env) => {
      const normalized = mapDraftOrderWebhookToNormalized(env.payload);
      const effectiveUpdatedAt =
        normalized.updatedAt ?? new Date().toISOString();

      const existing = await findOpportunityByDraftOrderId(normalized.shopifyDraftOrderId);
      if (!existing) {
        // tratamos como create (idempotencia inversa)
        const contact = await resolveOrCreateContactForDraftOrder(normalized, effectiveUpdatedAt);
        if (!contact) {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "draft_order_without_customer_ignored",
            entityType: "draft_order",
            entityId: null,
            payload: { shopify_draft_order_id: normalized.shopifyDraftOrderId },
          });
          return { discarded: true, reason: "no_customer" };
        }
        const stage = await resolveCotizacionStage();
        const tagAssignment = await resolveTagAssignment(normalized);
        const opp = await createOpportunity(
          buildOpportunityInsertFromDraftOrder({
            normalized,
            stageId: stage.id,
            contactId: contact.id,
            // Regla de prioridad opp>contacto: la opp toma el asesor del TAG
          // del draft, o queda NULL — NUNCA hereda el asesor HISTÓRICO del
          // contacto (que es ruido de pedidos viejos). El asesor real lo
          // rellena la orden vía el hook 0023 (solo NULL). R12 (lead sin
          // draft) sí hereda del contacto — ahí el contacto es el dueño
          // actual; este cambio es acotado al path de draft. Ver ERRORES.md.
          assignedAdvisorId: tagAssignment ?? null,
            isOutbound: contact.is_outbound,
            effectiveUpdatedAt,
          }),
        );
        await recordStageChange({
          opportunityId: opp.id,
          fromStageId: null,
          toStageId: stage.id,
          changedByUserId: null,
          context: "webhook",
        });
        await replaceLineItems(opp.id, normalized.lineItems.map(mapLineItemForOpportunity));
        // Mismo razonamiento que en draftOrdersCreate: este path
        // crea Cotización cuando draft_orders/update aterriza antes
        // que draft_orders/create (idempotencia inversa). Absorber
        // Lead nuevo R12 si existe activo para el contacto.
        await absorbInitialStageOpportunities({
          contactId: contact.id,
          absorbingOpportunityId: opp.id,
          trigger: "draft_orders_update_as_create",
        });
        await maybeFireF1ToF2(opp.id, normalized, env.eventId);
        return { opportunityId: opp.id, created: true };
      }

      if (!shouldApplyRecordUpdate(existing.last_modified_at, effectiveUpdatedAt)) {
        // Aunque el update sea "stale" por LWW, una completación NO
        // debe perderse: el trigger es idempotente, así que se evalúa
        // igual sobre la F1 ya conocida.
        await maybeFireF1ToF2(existing.id, normalized, env.eventId);
        return { opportunityId: existing.id, discarded: true, reason: "stale_update" };
      }

      const tagAssignment = await resolveTagAssignment(normalized);
      const patch = buildOpportunityPatchFromDraftOrder(normalized, effectiveUpdatedAt);
      if (tagAssignment) patch.assigned_advisor_id = tagAssignment;
      await updateOpportunity(existing.id, patch);
      await replaceLineItems(existing.id, normalized.lineItems.map(mapLineItemForOpportunity));
      await maybeFireF1ToF2(existing.id, normalized, env.eventId);
      return { opportunityId: existing.id, created: false };
    });
  },
);

// ============================================================
// 3) draft_orders/delete
// ============================================================
// Cancelación administrativa — NO es pérdida comercial (R5).
//
// La oportunidad queda marcada con `cancelled_at` + `cancellation_source`
// pero CONSERVA su etapa actual (auditoría: "esta opp estaba en X
// etapa cuando se canceló"). NO se inserta entrada en
// `opportunity_stage_history` porque no hubo cambio de etapa.
//
// Las queries del pipeline (M5/M6/M10) excluyen canceladas por
// default — `listOpportunities()` filtra `cancelled_at IS NULL`
// salvo opt-in explícito. Win rate del vendedor (Ganadas /
// (Ganadas + Perdidas)) NO incluye canceladas en el denominador.
//
// Triggers de cancelación administrativa cubiertos por este worker:
//   - Vendedor borra DO por error.
//   - DO duplicado / de prueba.
//   - Auto-borrado de Shopify tras 1 año de inactividad.
//
// Idempotencia: segundo webhook con mismo DO id no re-marca —
// `cancelOpportunity` preserva el primer `cancelled_at`.

export const draftOrdersDelete = inngest.createFunction(
  {
    id: "shopify-draft-orders-delete",
    retries: 3,
    triggers: [{ event: "shopify/draft_orders.delete" }],
  },
  async ({ event }) => {
    const envelope = event.data as unknown as ShopifyWebhookEnvelope;
    return runWebhookWorker(envelope, "draft_orders/delete", async (env) => {
      const payload = env.payload as { id?: number | string };
      const shopifyId = payload?.id;
      if (shopifyId === undefined || shopifyId === null) {
        throw new Error("draft_orders_delete: payload sin id");
      }
      const opp = await findOpportunityByDraftOrderId(String(shopifyId));
      if (!opp) return { discarded: true, reason: "not_local" };

      const result = await cancelOpportunity({
        opportunityId: opp.id,
        source: "shopify_draft_deleted",
        note: "[Sistema] Draft Order eliminado en Shopify — cancelación administrativa (no es pérdida comercial).",
      });
      if (result.alreadyCancelled) {
        return { opportunityId: opp.id, discarded: true, reason: "already_cancelled" };
      }
      return { opportunityId: result.opportunity.id, cancelled: true };
    });
  },
);

export const draftOrderFunctions = [
  draftOrdersCreate,
  draftOrdersUpdate,
  draftOrdersDelete,
];
