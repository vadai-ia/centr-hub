import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";
import { WHAAPY_DELETED_SHOPIFY_TAG } from "@/lib/constants";

/**
 * Archivado propagado por borrado en Whaapy (Fix A).
 *
 * Verifica la regla central del servicio compartido (worker + correctivo):
 *   - Cancela SOLO opps no-terminales (Ganada/Perdida se preservan).
 *   - Marca deleted_in_whaapy + audit `contact_archived_whaapy_deletion`.
 *   - Etiqueta el customer Shopify (tag, no borrado) si está enlazado;
 *     omite si no hay identidad Shopify o el tag ya está presente.
 *   - dry-run no escribe nada pero reporta el plan.
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

const updateCustomerTagsSpy = vi.fn().mockResolvedValue([WHAAPY_DELETED_SHOPIFY_TAG]);
vi.mock("@/lib/shopify/outbound", () => ({
  updateCustomerTags: (input: unknown) => updateCustomerTagsSpy(input),
  BackfillSuppressedError: class extends Error {},
}));

import { withTenantContext } from "@/lib/tenant/context";
import { archiveContactForWhaapyDeletion } from "@/lib/services/whaapy-contact-archival";
import { getOpportunityById } from "@/lib/db/opportunities";
import type { ContactRow } from "@/lib/types/database";

const ORG = "org-1";

function seedStages() {
  fake.setTable("pipeline_stages", [
    { id: "stage-lead", organization_id: ORG, funnel: "venta", name: "Lead nuevo", is_won: false, is_lost: false, is_initial: true, position: 1 },
    { id: "stage-ganada", organization_id: ORG, funnel: "venta", name: "Ganada", is_won: true, is_lost: false, position: 8 },
    { id: "stage-perdida", organization_id: ORG, funnel: "venta", name: "Perdida", is_won: false, is_lost: true, position: 9 },
  ]);
}

function seedOpp(id: string, stageId: string, extra: Record<string, unknown> = {}) {
  const row = {
    id,
    organization_id: ORG,
    funnel: "venta",
    stage_id: stageId,
    contact_id: "contact-1",
    assigned_advisor_id: null,
    parent_opportunity_id: null,
    shopify_draft_order_id: null,
    shopify_order_id: null,
    display_reference: `#D${id}`,
    actual_amount: null,
    estimated_amount: null,
    currency: "MXN",
    probability_override: null,
    weighted_amount: null,
    loss_reason_id: null,
    invoice_url: null,
    note: null,
    shipping_address: null,
    last_modified_at: "2026-05-01T00:00:00Z",
    last_modified_source: "shopify",
    won_at: null,
    lost_at: null,
    invoice_sent_at: null,
    cancelled_at: null,
    cancellation_source: null,
    cancellation_note: null,
    shopify_created_at: null,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...extra,
  };
  fake.setTable("opportunities", [...fake.getTable("opportunities"), row]);
  return row;
}

function seedContact(extra: Partial<ContactRow> = {}): ContactRow {
  const row = {
    id: "contact-1",
    organization_id: ORG,
    full_name: "Borrado Test",
    email: null,
    phone: "+525511112222",
    address: null,
    internal_note: null,
    shopify_state: null,
    shopify_tags: [],
    assigned_advisor_id: null,
    shopify_customer_id: null,
    whaapy_contact_id: "w-1",
    missing_phone: false,
    field_metadata: {},
    last_modified_at: "2026-06-01T00:00:00Z",
    last_modified_source: "whaapy",
    deleted_in_shopify: false,
    deleted_in_whaapy: true,
    anonymized_at: null,
    last_whaapy_activity_at: "2026-06-09T00:00:00Z",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...extra,
  } as ContactRow;
  fake.setTable("contacts", [row as unknown as Record<string, unknown>]);
  fake.setTable("organizations", [
    { id: ORG, shopify_store_domain: "centr.myshopify.com", backfill_in_progress: false },
  ]);
  return row;
}

beforeEach(() => {
  fake.reset();
  seedStages();
  updateCustomerTagsSpy.mockClear();
});

describe("archiveContactForWhaapyDeletion", () => {
  it("cancela opps no-terminales y PRESERVA Ganada/Perdida", async () => {
    const contact = seedContact();
    seedOpp("lead", "stage-lead");
    seedOpp("won", "stage-ganada", { won_at: "2026-06-02T00:00:00Z" });
    seedOpp("lost", "stage-perdida", { lost_at: "2026-06-02T00:00:00Z" });

    const result = await withTenantContext(ORG, () =>
      archiveContactForWhaapyDeletion({
        contact,
        deletedAt: "2026-06-09T12:00:00Z",
        source: "whaapy_webhook",
      }),
    );

    expect(result.cancelledOpportunityIds).toEqual(["lead"]);
    expect(result.preservedTerminalOpportunityIds.sort()).toEqual(["lost", "won"]);

    await withTenantContext(ORG, async () => {
      const lead = await getOpportunityById("lead");
      const won = await getOpportunityById("won");
      const lost = await getOpportunityById("lost");
      expect(lead?.cancelled_at).toBeTruthy();
      expect(lead?.cancellation_source).toBe("whaapy_contact_deleted");
      expect(lead?.stage_id).toBe("stage-lead"); // etapa preservada
      expect(won?.cancelled_at).toBeNull();
      expect(lost?.cancelled_at).toBeNull();
    });
  });

  it("etiqueta el customer Shopify (tag, no borrado) si está enlazado", async () => {
    const contact = seedContact({ shopify_customer_id: "100", shopify_tags: [] });
    seedOpp("lead", "stage-lead");

    const result = await withTenantContext(ORG, () =>
      archiveContactForWhaapyDeletion({ contact, deletedAt: "2026-06-09T12:00:00Z", source: "whaapy_webhook" }),
    );

    expect(result.shopifyTagged).toBe(true);
    expect(updateCustomerTagsSpy).toHaveBeenCalledTimes(1);
    const arg = updateCustomerTagsSpy.mock.calls[0][0] as { tagsToAdd: string[] };
    expect(arg.tagsToAdd).toEqual([WHAAPY_DELETED_SHOPIFY_TAG]);
  });

  it("sin identidad Shopify → no etiqueta", async () => {
    const contact = seedContact({ shopify_customer_id: null });
    const result = await withTenantContext(ORG, () =>
      archiveContactForWhaapyDeletion({ contact, deletedAt: "2026-06-09T12:00:00Z", source: "whaapy_webhook" }),
    );
    expect(result.shopifyTagged).toBe(false);
    expect(result.shopifySkipReason).toBe("no_shopify_identity");
    expect(updateCustomerTagsSpy).not.toHaveBeenCalled();
  });

  it("tag ya presente → idempotente, no re-etiqueta", async () => {
    const contact = seedContact({ shopify_customer_id: "100", shopify_tags: [WHAAPY_DELETED_SHOPIFY_TAG] });
    const result = await withTenantContext(ORG, () =>
      archiveContactForWhaapyDeletion({ contact, deletedAt: "2026-06-09T12:00:00Z", source: "whaapy_webhook" }),
    );
    expect(result.shopifyTagged).toBe(false);
    expect(result.shopifySkipReason).toBe("tag_already_present");
    expect(updateCustomerTagsSpy).not.toHaveBeenCalled();
  });

  it("marca deleted_in_whaapy + audit; conserva whaapy_contact_id", async () => {
    const contact = seedContact({ deleted_in_whaapy: false });
    const result = await withTenantContext(ORG, () =>
      archiveContactForWhaapyDeletion({ contact, deletedAt: "2026-06-09T12:00:00Z", source: "whaapy_webhook" }),
    );
    expect(result.alreadyArchived).toBe(false);
    const stored = fake.getTable("contacts")[0] as unknown as ContactRow;
    expect(stored.deleted_in_whaapy).toBe(true);
    expect(stored.whaapy_contact_id).toBe("w-1"); // identidad conservada
    const audits = fake.getTable("audit_log").filter(
      (a) => (a as { event_type: string }).event_type === "contact_archived_whaapy_deletion",
    );
    expect(audits).toHaveLength(1);
  });

  it("dry-run no escribe: opp activa, contacto sin tocar, sin tag", async () => {
    const contact = seedContact({ shopify_customer_id: "100", deleted_in_whaapy: false });
    seedOpp("lead", "stage-lead");

    const result = await withTenantContext(ORG, () =>
      archiveContactForWhaapyDeletion({ contact, deletedAt: "2026-06-09T12:00:00Z", source: "corrective_backfill", dryRun: true }),
    );

    // Reporta el plan...
    expect(result.cancelledOpportunityIds).toEqual(["lead"]);
    expect(result.shopifyTagged).toBe(true);
    // ...pero NO escribió nada.
    expect(updateCustomerTagsSpy).not.toHaveBeenCalled();
    await withTenantContext(ORG, async () => {
      const lead = await getOpportunityById("lead");
      expect(lead?.cancelled_at).toBeNull();
    });
    const audits = fake.getTable("audit_log") ?? [];
    expect(audits).toHaveLength(0);
  });
});
