/* eslint-disable no-console */
/**
 * M11 — Backfill completo de Shopify: contacts (1,103) + orders + opps de
 * Draft Order. Diseño: `CENTR-M11-BACKFILL-DESIGN.md`.
 *
 * SEGURO POR DEFAULT: corre en **DRY-RUN** salvo `--commit`. El dry-run no
 * escribe nada — reporta exactamente qué haría el run real (mismo matching,
 * mismos datos), y emite el CSV de reconciliación.
 *
 * Invariantes (locked en el diseño §4):
 *   - Single-thread (sin paralelismo → no hay race sin constraint).
 *   - Idempotente: dedup por `shopify_customer_id` / `shopify_order_id` /
 *     `shopify_draft_order_id` (constraints UNIQUE) → re-run = no-op.
 *   - Tier-phone enlaza SOLO a leads (`shopify_customer_id IS NULL`); nunca
 *     fusiona dos customers de Shopify que comparten teléfono.
 *   - Placeholder (teléfono compartido por ≥3 customers) → import phoneless
 *     + `missing_phone`; ese número nunca actúa como clave de match.
 *   - `backfill_in_progress=true` durante el commit → suprime outbound a
 *     Whaapy, R12/C2 y el motor de Post-venta. Restaurado en `finally`.
 *   - Solo la tienda de Centr.
 *
 * Uso:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/shopify/backfill-shopify-full.ts --org-slug centr            # dry-run
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/shopify/backfill-shopify-full.ts --org-slug centr --commit   # run real
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug, updateOrganization } from "@/lib/db/organizations";
import { shopifyRestCollection } from "@/lib/shopify/admin-client";
import {
  mapCustomerWebhookToNormalized,
  mapOrderWebhookToNormalized,
  mapDraftOrderWebhookToNormalized,
  type NormalizedCustomer,
  type NormalizedLineItem,
} from "@/lib/shopify/mappers";
import { normalizePhone, normalizeEmail } from "@/lib/services/identity-matching";
import {
  decideBackfillContactAction,
  resolveEffectivePhone,
  computePlaceholderPhones,
} from "@/lib/services/backfill-contact-decision";
import { parseShopifyTags } from "@/lib/services/tag-parser";
import {
  reconcileContactFields,
  shouldApplyRecordUpdate,
  type FieldProposal,
} from "@/lib/services/last-write-wins";
import {
  createContact,
  updateContact,
  findContactByShopifyCustomerId,
  findLeadsByPhone,
  findLeadsByEmail,
} from "@/lib/db/contacts";
import {
  createOrder,
  findOrderByShopifyOrderId,
  replaceOrderLineItems,
  updateOrder,
} from "@/lib/db/orders";
import { listPipelineStages } from "@/lib/db/pipeline";
import {
  createOpportunity,
  findOpportunityByDraftOrderId,
  recordStageChange,
  replaceLineItems,
} from "@/lib/db/opportunities";
import { recordAuditEvent } from "@/lib/db/operational";
import type { ContactRow, Json, UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

// ============================================================
// CLI
// ============================================================
function parseArgs() {
  let orgSlug = "centr";
  let commit = false;
  let maxCustomers: number | undefined;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? "centr";
    else if (argv[i] === "--commit") commit = true;
    else if (argv[i] === "--max-customers") maxCustomers = Number(argv[++i]);
  }
  return { orgSlug, commit, maxCustomers };
}

const PLACEHOLDER_MIN_SHARE = 3; // teléfono compartido por ≥3 customers = placeholder

interface ReconRow {
  type:
    | "placeholder_phoneless"
    | "phone_conflict_multi_lead"
    | "email_conflict_multi_lead"
    | "shared_phone_pair"
    | "no_strong_identifier"
    | "order_orphan_customer";
  shopify_customer_id: string | null;
  detail: string;
}

function mapLineItem(li: NormalizedLineItem) {
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

function buildContactInsert(
  n: NormalizedCustomer,
  phone: string | null,
  email: string | null,
  effAt: string,
): Parameters<typeof createContact>[0] {
  return {
    full_name: n.fullName,
    email,
    phone,
    address: (n.address ?? null) as Json | null,
    internal_note: n.note,
    shopify_state: n.state,
    shopify_tags: n.tags,
    assigned_advisor_id: null,
    shopify_customer_id: n.shopifyCustomerId,
    whaapy_contact_id: null,
    missing_phone: phone === null,
    field_metadata: {} as Json,
    last_modified_at: effAt,
    last_modified_source: "shopify",
    deleted_in_shopify: false,
    deleted_in_whaapy: false,
    anonymized_at: null,
    last_whaapy_activity_at: null,
  };
}

function buildProposals(
  n: NormalizedCustomer,
  phone: string | null,
  email: string | null,
  effAt: string,
): FieldProposal[] {
  // El teléfono del placeholder llega como null → el reconciler lo trata
  // como vacío (no sella metadata si el campo local también está vacío).
  return [
    { field: "full_name", value: n.fullName, updatedAt: effAt, source: "shopify" },
    { field: "email", value: email, updatedAt: effAt, source: "shopify" },
    { field: "phone", value: phone, updatedAt: effAt, source: "shopify" },
    { field: "address", value: n.address, updatedAt: effAt, source: "shopify" },
    { field: "internal_note", value: n.note, updatedAt: effAt, source: "shopify" },
    { field: "shopify_state", value: n.state, updatedAt: effAt, source: "shopify" },
    { field: "shopify_tags", value: n.tags, updatedAt: effAt, source: "shopify" },
  ];
}

async function resolveTagAdvisor(
  tags: string[],
  source: "customer" | "order" | "draft_order",
  entityId: string,
): Promise<UUID | null> {
  try {
    const r = await parseShopifyTags({ rawTags: tags, source, shopifyEntityId: entityId });
    return r.assignedMembership?.id ?? null;
  } catch {
    return null; // tag_mappings incompletos no deben romper el backfill
  }
}

// ============================================================
// Main
// ============================================================
async function main() {
  const args = parseArgs();
  const mode = args.commit ? "COMMIT" : "DRY-RUN";
  void getSupabaseAdminClient();

  const org = await getOrganizationBySlug(args.orgSlug);
  if (!org) throw new Error(`org ${args.orgSlug} no encontrada`);
  if (org.slug !== "centr") throw new Error(`solo la tienda de Centr — slug recibido: ${org.slug}`);
  if (!org.shopify_store_domain) throw new Error(`org ${args.orgSlug} sin shopify_store_domain`);
  const shopCtx = { organizationId: org.id as UUID, shopDomain: org.shopify_store_domain };

  console.log(`\n=== M11 BACKFILL SHOPIFY — modo ${mode} — ${org.name} (${org.shopify_store_domain}) ===\n`);

  const recon: ReconRow[] = [];
  const consumedLeadIds = new Set<UUID>();
  const c = {
    contactsCreated: 0, contactsLinked: 0, contactsUpdated: 0, contactsConflict: 0,
    placeholderPhoneless: 0, phoneless: 0, noStrongId: 0,
    ordersCreated: 0, ordersUpdated: 0, ordersStale: 0, ordersNoCustomer: 0, ordersOrphan: 0,
    oppsCreated: 0, oppsExisting: 0, oppsNoCustomer: 0, oppsCompletedSkipped: 0,
  };

  if (args.commit) {
    await updateOrganization(org.id, { backfill_in_progress: true } as never);
    console.log("backfill_in_progress = true (suprime outbound Whaapy + R12 + motor Post-venta)\n");
  }

  try {
    await withTenantContext(
      org.id as UUID,
      async () => {
        // ---- PHASE 0: pull ----
        console.log("Pulling Shopify (REST paginado)…");
        let customersRaw = await shopifyRestCollection<unknown>(
          shopCtx, "/customers.json?limit=250", "customers",
        );
        if (args.maxCustomers) customersRaw = customersRaw.slice(0, args.maxCustomers);
        const ordersRaw = await shopifyRestCollection<unknown>(
          shopCtx, "/orders.json?status=any&limit=250", "orders",
        );
        const draftsRaw = await shopifyRestCollection<unknown>(
          shopCtx, "/draft_orders.json?limit=250", "draft_orders",
        );
        console.log(`  customers=${customersRaw.length} orders=${ordersRaw.length} draft_orders=${draftsRaw.length}\n`);

        const customers = customersRaw.map(mapCustomerWebhookToNormalized);
        const pulledCustomerIds = new Set(customers.map((n) => n.shopifyCustomerId));

        // ---- placeholder set: teléfono compartido por ≥3 customers ----
        const phoneFreq = new Map<string, number>();
        for (const n of customers) {
          const p = normalizePhone(n.phone, "MX");
          if (p) phoneFreq.set(p, (phoneFreq.get(p) ?? 0) + 1);
        }
        const placeholderSet = computePlaceholderPhones(phoneFreq, PLACEHOLDER_MIN_SHARE);
        const sharedPairs = new Set(
          Array.from(phoneFreq.entries()).filter(([, k]) => k === 2).map(([p]) => p),
        );
        console.log(`Placeholder numbers (≥${PLACEHOLDER_MIN_SHARE} customers): ${placeholderSet.size}; shared ×2 pairs: ${sharedPairs.size}\n`);

        // ---- PHASE 1: contacts ----
        for (const n of customers) {
          const normPhone = normalizePhone(n.phone, "MX");
          const { effectivePhone: effPhone, isPlaceholder } = resolveEffectivePhone(normPhone, placeholderSet);
          const normEmail = normalizeEmail(n.email);
          const effAt = n.updatedAt ?? n.createdAt ?? new Date().toISOString();

          if (!effPhone && !normEmail) { c.noStrongId++; recon.push({ type: "no_strong_identifier", shopify_customer_id: n.shopifyCustomerId, detail: n.fullName ?? "" }); }
          if (isPlaceholder) { c.placeholderPhoneless++; recon.push({ type: "placeholder_phoneless", shopify_customer_id: n.shopifyCustomerId, detail: `${n.fullName ?? ""} (placeholder ${normPhone})` }); }
          else if (effPhone === null) c.phoneless++;
          if (effPhone && sharedPairs.has(effPhone)) recon.push({ type: "shared_phone_pair", shopify_customer_id: n.shopifyCustomerId, detail: `${n.fullName ?? ""} shares ${effPhone}` });

          const existing = await findContactByShopifyCustomerId(n.shopifyCustomerId);
          // tier-phone/email → SOLO leads (excluye clientes y leads ya consumidos
          // en este run) — decisión pura en decideBackfillContactAction.
          const leadIdsByPhone = existing || !effPhone
            ? []
            : (await findLeadsByPhone(effPhone)).filter((l) => !consumedLeadIds.has(l.id)).map((l) => l.id);
          const leadIdsByEmail = existing || !normEmail
            ? []
            : (await findLeadsByEmail(normEmail)).filter((l) => !consumedLeadIds.has(l.id)).map((l) => l.id);

          const decision = decideBackfillContactAction({
            existsByCustomerId: !!existing,
            effectivePhone: effPhone,
            effectiveEmail: normEmail,
            leadIdsByPhone,
            leadIdsByEmail,
          });

          switch (decision.kind) {
            case "update":
              c.contactsUpdated++;
              if (args.commit && existing) await applyContactUpdate(existing, n, effPhone, normEmail, effAt, false);
              break;
            case "link":
              consumedLeadIds.add(decision.leadId as UUID);
              c.contactsLinked++;
              if (args.commit) {
                const linked = await updateContact(decision.leadId as UUID, { shopify_customer_id: n.shopifyCustomerId });
                await applyContactUpdate(linked, n, effPhone, normEmail, effAt, true);
              }
              break;
            case "conflict":
              c.contactsConflict++;
              recon.push({ type: decision.matchBy === "phone" ? "phone_conflict_multi_lead" : "email_conflict_multi_lead", shopify_customer_id: n.shopifyCustomerId, detail: `${n.fullName ?? ""} matched >1 lead by ${decision.matchBy}` });
              if (args.commit) {
                const created = await createContact(buildContactInsert(n, effPhone, normEmail, effAt));
                await applyContactUpdate(created, n, effPhone, normEmail, effAt, false);
              }
              break;
            case "create":
              c.contactsCreated++;
              if (args.commit) {
                const created = await createContact(buildContactInsert(n, effPhone, normEmail, effAt));
                await applyContactUpdate(created, n, effPhone, normEmail, effAt, false);
              }
              break;
          }
        }

        // ---- PHASE 2: orders ----
        for (const raw of ordersRaw) {
          const o = mapOrderWebhookToNormalized(raw);
          if (!o.shopifyCustomerId) { c.ordersNoCustomer++; continue; }
          const attributable = pulledCustomerIds.has(o.shopifyCustomerId)
            || !!(await findContactByShopifyCustomerId(o.shopifyCustomerId));
          if (!attributable) {
            c.ordersOrphan++;
            recon.push({ type: "order_orphan_customer", shopify_customer_id: o.shopifyCustomerId, detail: `order ${o.shopifyOrderId} customer not in pull` });
            continue;
          }
          const effAt = o.updatedAt ?? o.paidAt ?? o.createdAt ?? new Date().toISOString();
          const existing = await findOrderByShopifyOrderId(o.shopifyOrderId);
          if (!existing) {
            c.ordersCreated++;
            if (args.commit) {
              const contact = await findContactByShopifyCustomerId(o.shopifyCustomerId);
              if (!contact) { c.ordersOrphan++; continue; }
              const advisor = await resolveTagAdvisor(o.tags, "order", o.shopifyOrderId);
              const created = await createOrder({
                contact_id: contact.id, assigned_advisor_id: advisor, opportunity_id: null,
                shopify_order_id: o.shopifyOrderId, shopify_name: o.shopifyName,
                financial_status: o.financialStatus, fulfillment_status: o.fulfillmentStatus,
                total_amount: o.totalAmount, subtotal: o.subtotalAmount, taxes_amount: o.taxesAmount,
                shipping_amount: o.shippingAmount, discount_amount: o.discountAmount, currency: o.currency,
                cancellation_reason: o.cancellationReason, source: o.source, shopify_tags: o.tags,
                last_modified_at: effAt, last_modified_source: "shopify",
                paid_at: o.paidAt, cancelled_at: o.cancelledAt,
                shopify_created_at: o.createdAt, delivery_status: o.deliveryStatus,
              });
              await replaceOrderLineItems(created.id, o.lineItems.map(mapLineItem));
            }
          } else if (shouldApplyRecordUpdate(existing.last_modified_at, effAt)) {
            c.ordersUpdated++;
            if (args.commit) {
              await updateOrder(existing.id, {
                financial_status: o.financialStatus, fulfillment_status: o.fulfillmentStatus,
                total_amount: o.totalAmount, subtotal: o.subtotalAmount, taxes_amount: o.taxesAmount,
                shipping_amount: o.shippingAmount, discount_amount: o.discountAmount, currency: o.currency,
                cancellation_reason: o.cancellationReason, source: o.source, shopify_tags: o.tags,
                paid_at: o.paidAt ?? existing.paid_at, cancelled_at: o.cancelledAt ?? existing.cancelled_at,
                delivery_status: o.deliveryStatus ?? existing.delivery_status,
                last_modified_at: effAt, last_modified_source: "shopify",
                shopify_created_at: o.createdAt ?? existing.shopify_created_at,
              });
              await replaceOrderLineItems(existing.id, o.lineItems.map(mapLineItem));
            }
          } else {
            c.ordersStale++;
          }
        }

        // ---- PHASE 3: Draft Order → opp Cotización (SIN F1→F2 ni R12) ----
        // Solo drafts en curso (open/invoice_sent). Los COMPLETADOS ya son
        // ventas cerradas — viven como `orders` (su revenue está ahí). Traerlos
        // como "Cotización" inundaría el pipeline con ventas pasadas en la
        // primera etapa (F1→F2 está suprimido, no avanzarían a Ganada). La
        // reconstrucción de win-rate histórico es un milestone aparte.
        const stages = await listPipelineStages("venta");
        const cotizacion = stages.find((s) => s.name === "Cotización");
        if (!cotizacion) throw new Error('no se encontró etapa "Cotización" en Funnel Venta');
        for (const raw of draftsRaw) {
          const d = mapDraftOrderWebhookToNormalized(raw);
          if (d.status === "completed" || d.completedAt) { c.oppsCompletedSkipped++; continue; }
          if (!d.shopifyCustomerId) { c.oppsNoCustomer++; continue; }
          const attributable = pulledCustomerIds.has(d.shopifyCustomerId)
            || !!(await findContactByShopifyCustomerId(d.shopifyCustomerId));
          if (!attributable) { c.oppsNoCustomer++; continue; }
          const existing = await findOpportunityByDraftOrderId(d.shopifyDraftOrderId);
          if (existing) { c.oppsExisting++; continue; }
          c.oppsCreated++;
          if (args.commit) {
            const contact = await findContactByShopifyCustomerId(d.shopifyCustomerId);
            if (!contact) { c.oppsNoCustomer++; continue; }
            const effAt = d.updatedAt ?? d.createdAt ?? new Date().toISOString();
            const advisor = await resolveTagAdvisor(d.tags, "draft_order", d.shopifyDraftOrderId);
            const opp = await createOpportunity({
              funnel: "venta", stage_id: cotizacion.id, contact_id: contact.id,
              assigned_advisor_id: advisor, parent_opportunity_id: null,
              shopify_draft_order_id: d.shopifyDraftOrderId, shopify_order_id: null,
              shopify_created_at: d.createdAt, display_reference: d.displayReference,
              actual_amount: d.totalAmount, estimated_amount: null, currency: d.currency,
              probability_override: null, weighted_amount: null, loss_reason_id: null,
              invoice_url: d.invoiceUrl, note: d.note,
              shipping_address: (d.shippingAddress ?? null) as Json | null,
              last_modified_at: effAt, last_modified_source: "shopify",
              won_at: null, lost_at: null, invoice_sent_at: null,
              cancelled_at: null, cancellation_source: null, cancellation_note: null,
            });
            await recordStageChange({
              opportunityId: opp.id, fromStageId: null, toStageId: cotizacion.id,
              changedByUserId: null, context: "webhook", shopifyEventAt: d.createdAt,
            });
            await replaceLineItems(opp.id, d.lineItems.map(mapLineItem));
          }
        }

        if (args.commit) {
          await recordAuditEvent({
            actorUserId: null, eventType: "backfill_full_finished", entityType: null, entityId: null,
            payload: c as unknown as Json,
          });
        }
      },
      { source: "script" },
    );
  } finally {
    if (args.commit) {
      await updateOrganization(org.id, { backfill_in_progress: false } as never);
      console.log("\nbackfill_in_progress restaurado a false.");
    }
  }

  // ---- report ----
  console.log("\n================= RESUMEN =================");
  console.log(`  Contactos:  crear=${c.contactsCreated} enlazar=${c.contactsLinked} actualizar=${c.contactsUpdated} conflicto=${c.contactsConflict}`);
  console.log(`              placeholder→phoneless=${c.placeholderPhoneless} otros phoneless=${c.phoneless} sin identificador=${c.noStrongId}`);
  console.log(`  Órdenes:    crear=${c.ordersCreated} actualizar=${c.ordersUpdated} stale=${c.ordersStale} sin-customer=${c.ordersNoCustomer} huérfanas=${c.ordersOrphan}`);
  console.log(`  Opps DO:    crear=${c.oppsCreated} existentes=${c.oppsExisting} completadas-omitidas=${c.oppsCompletedSkipped} sin-customer=${c.oppsNoCustomer}`);

  const reportPath = resolve(process.cwd(), `backfill-recon-report.csv`);
  const csv = ["type,shopify_customer_id,detail", ...recon.map((r) => `${r.type},${r.shopify_customer_id ?? ""},"${(r.detail ?? "").replace(/"/g, "'")}"`)].join("\n");
  writeFileSync(reportPath, csv, "utf8");
  console.log(`\n  Reconciliación (${recon.length} filas) → ${reportPath}`);
  console.log(`\n[${mode}] ${args.commit ? "cambios aplicados." : "sin escrituras — dry-run."}\n`);
}

/**
 * Aplica LWW por campo sobre un contacto (creado, enlazado o pre-existente),
 * espejando `customersCreate`/`customersUpdate` pero SIN outbound a Whaapy.
 */
async function applyContactUpdate(
  contact: ContactRow,
  n: NormalizedCustomer,
  phone: string | null,
  email: string | null,
  effAt: string,
  isInitialMatch: boolean,
): Promise<void> {
  const proposals = buildProposals(n, phone, email, effAt);
  const reconciled = reconcileContactFields(contact, proposals, { isInitialMatch });
  const advisor = await resolveTagAdvisor(n.tags, "customer", n.shopifyCustomerId);
  const patch: Record<string, unknown> = {
    ...reconciled.patch,
    field_metadata: reconciled.nextFieldMetadata,
    last_modified_at: effAt,
    last_modified_source: "shopify",
    missing_phone: phone === null,
  };
  if (advisor !== null && contact.assigned_advisor_id !== advisor) patch.assigned_advisor_id = advisor;
  await updateContact(contact.id, patch);
}

main().catch((e: Error) => {
  console.error("BACKFILL FALLÓ:", e.message);
  if ((e as unknown as { body?: unknown }).body) console.dir((e as unknown as { body: unknown }).body, { depth: 4 });
  process.exit(1);
});
