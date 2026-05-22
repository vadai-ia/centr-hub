/* eslint-disable no-console */
/**
 * Backfill incremental (M3) — 10-20 órdenes recientes de Shopify.
 *
 * Lee REST `GET /orders.json` con `limit=20` y `status=any`, mapea
 * con el mismo `mapOrderWebhookToNormalized` que usan los workers
 * de webhooks y los aplica via el mismo helper de upsert. Esto
 * garantiza que el código de backfill ejerce el mismo path crítico
 * que los workers de producción.
 *
 * Importante (Sección "Supresión de llamadas salientes"):
 *   - El script setea `organizations.backfill_in_progress=true`
 *     antes de iniciar y lo restaura al finalizar (incluso si falla).
 *   - Durante el backfill los workers outbound a Shopify están
 *     bloqueados (BackfillSuppressedError). Los workers inbound
 *     siguen activos — el backfill no genera webhooks (es REST puro).
 *
 * El backfill COMPLETO desde apertura de tienda es M11 (Bulk
 * Operations + GraphQL + chunks via Inngest).
 *
 * Uso:
 *   npx tsx scripts/shopify/backfill-incremental.ts --org-slug centr [--limit 20]
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug, updateOrganization } from "@/lib/db/organizations";
import { shopifyRest } from "@/lib/shopify/admin-client";
import {
  mapCustomerWebhookToNormalized,
  mapOrderWebhookToNormalized,
} from "@/lib/shopify/mappers";
import { matchContactIdentity } from "@/lib/services/identity-matching";
import { parseShopifyTags } from "@/lib/services/tag-parser";
import { shouldApplyRecordUpdate } from "@/lib/services/last-write-wins";
import {
  createContact,
  findContactByShopifyCustomerId,
  updateContact,
} from "@/lib/db/contacts";
import {
  createOrder,
  findOrderByShopifyOrderId,
  replaceOrderLineItems,
  updateOrder,
} from "@/lib/db/orders";
import { findOpportunityByDraftOrderId } from "@/lib/db/opportunities";
import { recordAuditEvent } from "@/lib/db/operational";
import type { Json, UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function parseArgs() {
  let orgSlug: string | null = null;
  let limit = 20;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--limit") limit = Number(argv[++i] ?? 20);
  }
  if (!orgSlug) {
    console.error("Uso: tsx backfill-incremental.ts --org-slug <slug> [--limit N]");
    process.exit(2);
  }
  return { orgSlug, limit };
}

async function backfillContact(
  shopifyCustomerId: string,
  ctx: { organizationId: UUID; shopDomain: string },
): Promise<UUID> {
  const existing = await findContactByShopifyCustomerId(shopifyCustomerId);
  if (existing) return existing.id;

  // GET customer details
  const res = await shopifyRest<{ customer: unknown }>(
    ctx,
    "GET",
    `/customers/${shopifyCustomerId}.json`,
  );
  const normalized = mapCustomerWebhookToNormalized(res.customer);
  const now =
    normalized.updatedAt ?? normalized.createdAt ?? new Date().toISOString();

  const match = await matchContactIdentity({
    source: "shopify",
    shopifyCustomerId: normalized.shopifyCustomerId,
    phone: normalized.phone,
    email: normalized.email,
  });
  if (match.match) {
    const updated = await updateContact(match.match.id, {
      shopify_customer_id: normalized.shopifyCustomerId,
      full_name: normalized.fullName ?? match.match.full_name,
      email: match.normalizedEmail ?? match.match.email,
      phone: match.normalizedPhone ?? match.match.phone,
      shopify_tags: normalized.tags,
      shopify_state: normalized.state,
      address: (normalized.address ?? match.match.address ?? null) as Json | null,
      missing_phone: match.normalizedPhone === null,
      last_modified_at: now,
      last_modified_source: "shopify",
    });
    return updated.id;
  }
  const created = await createContact({
    full_name: normalized.fullName,
    email: match.normalizedEmail,
    phone: match.normalizedPhone,
    address: (normalized.address ?? null) as Json | null,
    internal_note: normalized.note,
    shopify_state: normalized.state,
    shopify_tags: normalized.tags,
    assigned_advisor_id: null,
    shopify_customer_id: normalized.shopifyCustomerId,
    whaapy_contact_id: null,
    missing_phone: match.normalizedPhone === null,
    field_metadata: {} as Json,
    last_modified_at: now,
    last_modified_source: "shopify",
    deleted_in_shopify: false,
    deleted_in_whaapy: false,
    anonymized_at: null,
    last_whaapy_activity_at: null,
  });
  return created.id;
}

async function backfillOrders(opts: {
  organizationId: UUID;
  shopDomain: string;
  limit: number;
}) {
  const res = await shopifyRest<{ orders: unknown[] }>(
    opts,
    "GET",
    `/orders.json?status=any&limit=${opts.limit}`,
  );
  const orders = res.orders ?? [];
  console.log(`Recibidas ${orders.length} órdenes de Shopify.`);

  let imported = 0;
  let skipped = 0;
  for (const raw of orders) {
    const normalized = mapOrderWebhookToNormalized(raw);
    const effectiveUpdatedAt =
      normalized.updatedAt ?? normalized.createdAt ?? new Date().toISOString();

    if (!normalized.shopifyCustomerId) {
      console.warn(`[skip] order ${normalized.shopifyOrderId} sin customer`);
      skipped++;
      continue;
    }
    const contactId = await backfillContact(normalized.shopifyCustomerId, opts);
    const tagParse = await parseShopifyTags({
      rawTags: normalized.tags,
      source: "order",
      shopifyEntityId: normalized.shopifyOrderId,
    });
    const opportunityId = normalized.shopifyDraftOrderId
      ? (await findOpportunityByDraftOrderId(normalized.shopifyDraftOrderId))?.id ?? null
      : null;

    const existing = await findOrderByShopifyOrderId(normalized.shopifyOrderId);
    if (!existing) {
      const created = await createOrder({
        contact_id: contactId,
        assigned_advisor_id: tagParse.assignedMembership?.id ?? null,
        opportunity_id: opportunityId,
        shopify_order_id: normalized.shopifyOrderId,
        shopify_name: normalized.shopifyName,
        financial_status: normalized.financialStatus,
        fulfillment_status: normalized.fulfillmentStatus,
        total_amount: normalized.totalAmount,
        subtotal: normalized.subtotalAmount,
        taxes_amount: normalized.taxesAmount,
        shipping_amount: normalized.shippingAmount,
        discount_amount: normalized.discountAmount,
        currency: normalized.currency,
        cancellation_reason: normalized.cancellationReason,
        source: normalized.source,
        shopify_tags: normalized.tags,
        last_modified_at: effectiveUpdatedAt,
        last_modified_source: "shopify",
        paid_at: normalized.paidAt,
        cancelled_at: normalized.cancelledAt,
      });
      await replaceOrderLineItems(
        created.id,
        normalized.lineItems.map((li) => ({
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
        })),
      );
      imported++;
      continue;
    }

    if (!shouldApplyRecordUpdate(existing.last_modified_at, effectiveUpdatedAt)) {
      skipped++;
      continue;
    }
    await updateOrder(existing.id, {
      contact_id: contactId,
      opportunity_id: opportunityId ?? existing.opportunity_id,
      financial_status: normalized.financialStatus,
      fulfillment_status: normalized.fulfillmentStatus,
      total_amount: normalized.totalAmount,
      subtotal: normalized.subtotalAmount,
      taxes_amount: normalized.taxesAmount,
      shipping_amount: normalized.shippingAmount,
      discount_amount: normalized.discountAmount,
      currency: normalized.currency,
      cancellation_reason: normalized.cancellationReason,
      source: normalized.source,
      shopify_tags: normalized.tags,
      paid_at: normalized.paidAt ?? existing.paid_at,
      cancelled_at: normalized.cancelledAt ?? existing.cancelled_at,
      last_modified_at: effectiveUpdatedAt,
      last_modified_source: "shopify",
      assigned_advisor_id: tagParse.assignedMembership?.id ?? existing.assigned_advisor_id,
    });
    await replaceOrderLineItems(
      existing.id,
      normalized.lineItems.map((li) => ({
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
      })),
    );
    imported++;
  }
  return { imported, skipped };
}

async function main() {
  const args = parseArgs();
  void getSupabaseAdminClient(); // forzar init temprano
  const org = await getOrganizationBySlug(args.orgSlug);
  if (!org) {
    console.error(`org ${args.orgSlug} no encontrada`);
    process.exit(1);
  }
  if (!org.shopify_store_domain) {
    console.error(`org ${args.orgSlug} no tiene shopify_store_domain`);
    process.exit(1);
  }
  const ctx = {
    organizationId: org.id as UUID,
    shopDomain: org.shopify_store_domain,
  };

  console.log(`Backfill incremental para ${org.name} (limit=${args.limit})`);
  await updateOrganization(org.id, {
    // cast — columna v5.1 no está en hand-written types todavía
    backfill_in_progress: true,
  } as unknown as Partial<typeof org>);

  try {
    const result = await withTenantContext(
      ctx.organizationId,
      async () => {
        await recordAuditEvent({
          actorUserId: null,
          eventType: "backfill_incremental_started",
          entityType: null,
          entityId: null,
          payload: { limit: args.limit, shop_domain: ctx.shopDomain },
        });
        const r = await backfillOrders({ ...ctx, limit: args.limit });
        await recordAuditEvent({
          actorUserId: null,
          eventType: "backfill_incremental_finished",
          entityType: null,
          entityId: null,
          payload: r,
        });
        return r;
      },
      { source: "script" },
    );
    console.log(
      `Backfill terminado. importadas=${result.imported} skipped=${result.skipped}`,
    );
  } finally {
    await updateOrganization(org.id, {
      backfill_in_progress: false,
    } as unknown as Partial<typeof org>);
    console.log("backfill_in_progress restaurado a false.");
  }
}

main().catch((err: Error) => {
  console.error("backfill-incremental falló:", err.message);
  process.exit(1);
});
