import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * recordWhaapySyncIntent emite evento Inngest + audit log paralelo
 * (fix(M3) — drena automático cuando M4 deploye).
 *
 * Verifica:
 *   - Se inserta audit log `whaapy_sync_intent_recorded`.
 *   - Se llama `inngest.send` con el evento
 *     `whaapy/outbound.contact_sync_requested` Y el snapshot completo
 *     del contact en `data.contactSnapshot`.
 *   - El reason ("create_from_shopify" vs "update_from_shopify") se
 *     propaga al payload.
 *   - La guardia de invocación vive en el worker, no en este helper —
 *     este test ejercita el camino feliz "el worker decidió emitir".
 */

// vi.hoisted: customers.ts evalúa `const inngest = getInngestClient()`
// en module-top — el `new FakeInngest()` necesita `sendMock` ya
// inicializado ANTES de que los imports se resuelvan. `vi.hoisted`
// garantiza que sendMock viva en el mismo scope hoisteado que los
// vi.mock. (Patrón distinto al de webhook-endpoint.test.ts donde
// el handler es lazy y no toca Inngest al cargar el módulo.)
const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(async () => ({ ids: ["evt-1"] })),
}));

const fake = new FakeSupabase();

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

vi.mock("inngest", () => ({
  Inngest: class FakeInngest {
    constructor() {}
    send = sendMock;
    createFunction() {
      return {};
    }
  },
}));

import { withTenantContext } from "@/lib/tenant/context";
import { recordWhaapySyncIntent } from "@/lib/inngest/functions/customers";
import type { ContactRow, Json } from "@/lib/types/database";

const ORG = "org-1";

function makeContact(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: "contact-1",
    organization_id: ORG,
    full_name: "Ana Pérez",
    email: "ana@example.com",
    phone: "+525555555555",
    address: { city: "CDMX" } as Json,
    internal_note: "VIP",
    shopify_tags: ["Gina"],
    shopify_state: "enabled",
    assigned_advisor_id: "membership-1",
    shopify_customer_id: "12345",
    whaapy_contact_id: null,
    field_metadata: { email: { updated_at: "2026-05-01T00:00:00Z", source: "shopify" } } as Json,
    last_modified_at: "2026-05-01T00:00:00Z",
    last_modified_source: "shopify",
    missing_phone: false,
    deleted_in_shopify: false,
    deleted_in_whaapy: false,
    anonymized_at: null,
    last_whaapy_activity_at: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  fake.reset();
  sendMock.mockClear();
});

describe("recordWhaapySyncIntent — fix(M3) emite Inngest event en vez de solo audit", () => {
  it("create_from_shopify: audit log + evento Inngest con snapshot completo", async () => {
    const contact = makeContact({ whaapy_contact_id: null });
    await withTenantContext(ORG, async () => {
      await recordWhaapySyncIntent(contact, "create_from_shopify");
    });

    // Audit log
    const auditEvents = fake.getTable("audit_log");
    expect(auditEvents).toHaveLength(1);
    const audit = auditEvents[0] as {
      event_type: string;
      entity_id: string;
      payload: { reason: string; has_phone: boolean };
    };
    expect(audit.event_type).toBe("whaapy_sync_intent_recorded");
    expect(audit.entity_id).toBe("contact-1");
    expect(audit.payload.reason).toBe("create_from_shopify");
    expect(audit.payload.has_phone).toBe(true);

    // Evento Inngest
    expect(sendMock).toHaveBeenCalledTimes(1);
    const calls = sendMock.mock.calls as unknown as Array<[unknown]>;
    const call = calls[0][0] as {
      name: string;
      data: {
        organizationId: string;
        contactId: string;
        reason: string;
        contactSnapshot: Record<string, unknown>;
      };
    };
    expect(call.name).toBe("whaapy/outbound.contact_sync_requested");
    expect(call.data.organizationId).toBe(ORG);
    expect(call.data.contactId).toBe("contact-1");
    expect(call.data.reason).toBe("create_from_shopify");
    expect(call.data.contactSnapshot).toMatchObject({
      shopifyCustomerId: "12345",
      whaapyContactId: null,
      fullName: "Ana Pérez",
      email: "ana@example.com",
      phone: "+525555555555",
      shopifyTags: ["Gina"],
      shopifyState: "enabled",
      assignedAdvisorId: "membership-1",
      lastModifiedAt: "2026-05-01T00:00:00Z",
      lastModifiedSource: "shopify",
    });
  });

  it("update_from_shopify: emite con whaapyContactId presente en snapshot", async () => {
    const contact = makeContact({ whaapy_contact_id: "whaapy-abc-789" });
    await withTenantContext(ORG, async () => {
      await recordWhaapySyncIntent(contact, "update_from_shopify");
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const calls = sendMock.mock.calls as unknown as Array<[unknown]>;
    const call = calls[0][0] as {
      data: { reason: string; contactSnapshot: { whaapyContactId: string | null } };
    };
    expect(call.data.reason).toBe("update_from_shopify");
    expect(call.data.contactSnapshot.whaapyContactId).toBe("whaapy-abc-789");
  });

  it("snapshot preserva field_metadata y address como JSON (M4 los usa para LWW)", async () => {
    const contact = makeContact({
      address: { street: "Calle Principal 42", country: "MX" } as Json,
      field_metadata: {
        full_name: { updated_at: "2026-05-01T00:00:00Z", source: "shopify" },
        email: { updated_at: "2026-05-02T00:00:00Z", source: "whaapy" },
      } as Json,
    });
    await withTenantContext(ORG, async () => {
      await recordWhaapySyncIntent(contact, "update_from_shopify");
    });

    const calls = sendMock.mock.calls as unknown as Array<[unknown]>;
    const call = calls[0][0] as {
      data: { contactSnapshot: { address: unknown; fieldMetadata: unknown } };
    };
    expect(call.data.contactSnapshot.address).toEqual({
      street: "Calle Principal 42",
      country: "MX",
    });
    expect(call.data.contactSnapshot.fieldMetadata).toEqual({
      full_name: { updated_at: "2026-05-01T00:00:00Z", source: "shopify" },
      email: { updated_at: "2026-05-02T00:00:00Z", source: "whaapy" },
    });
  });

  it("audit log se escribe ANTES de inngest.send (trazabilidad incluso si emit falla)", async () => {
    // El orden importa: si inngest.send fallara, el audit ya quedó persistido
    // y un operador podría reintentar manualmente.
    const contact = makeContact();
    const order: string[] = [];

    // Interceptar audit insert para registrar orden
    const originalGetTable = fake.getTable.bind(fake);
    fake.getTable = (name: string) => {
      if (name === "audit_log" && order.length === 0) order.push("audit_log_insert");
      return originalGetTable(name);
    };
    sendMock.mockImplementationOnce(async () => {
      order.push("inngest_send");
      return { ids: ["evt-x"] };
    });

    await withTenantContext(ORG, async () => {
      await recordWhaapySyncIntent(contact, "create_from_shopify");
    });

    expect(order[0]).toBe("audit_log_insert");
    expect(order[1]).toBe("inngest_send");
  });
});
