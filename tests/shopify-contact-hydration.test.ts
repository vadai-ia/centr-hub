import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Fix M3 — contactos Shopify creados vacíos desde orders/draft_orders.
 *
 * Antes del fix, cuando llegaba un webhook de orden/draft-order para
 * un customer que no existía localmente, el worker creaba un contact
 * con TODOS los campos en NULL (stub). El payload de la orden trae
 * el objeto customer completo (no solo id), pero los schemas Zod lo
 * descartaban.
 *
 * Este test ejercita el helper compartido
 * `hydrateContactFromEmbeddedShopifyCustomer` que orders.ts y
 * draft-orders.ts usan para nacer el contact con datos reales.
 */

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
import { hydrateContactFromEmbeddedShopifyCustomer } from "@/lib/inngest/functions/customers";
import type { NormalizedCustomer } from "@/lib/shopify/mappers";
import type { Json } from "@/lib/types/database";

const ORG = "org-1";

function makeNormalizedCustomer(
  overrides: Partial<NormalizedCustomer> = {},
): NormalizedCustomer {
  return {
    shopifyCustomerId: "10014784815380",
    fullName: "Ana Pérez",
    email: "ana@example.com",
    phone: "+525555555555",
    tags: ["Gina"],
    state: "enabled",
    note: null,
    address: { city: "CDMX" },
    updatedAt: "2026-05-15T10:00:00Z",
    createdAt: "2026-05-10T10:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  fake.reset();
  sendMock.mockClear();
});

describe("hydrateContactFromEmbeddedShopifyCustomer — fix M3 contactos vacíos", () => {
  it("crea contacto hidratado cuando no existe local (path principal del fix)", async () => {
    const normalized = makeNormalizedCustomer();

    const result = await withTenantContext(ORG, async () => {
      return hydrateContactFromEmbeddedShopifyCustomer(
        normalized,
        normalized.updatedAt ?? "2026-05-15T10:00:00Z",
      );
    });

    expect(result.shopify_customer_id).toBe("10014784815380");
    expect(result.full_name).toBe("Ana Pérez");
    expect(result.email).toBe("ana@example.com");
    expect(result.phone).toBe("+525555555555");
    expect(result.shopify_tags).toEqual(["Gina"]);
    expect(result.shopify_state).toBe("enabled");
    expect(result.missing_phone).toBe(false);
    expect(result.last_modified_source).toBe("shopify");
    expect(result.last_modified_at).toBe("2026-05-15T10:00:00Z");

    // field_metadata poblado por LWW para reconciliar con eventos futuros
    const meta = result.field_metadata as Record<string, { source: string }>;
    expect(meta).toBeTruthy();
    expect(meta.full_name?.source).toBe("shopify");
    expect(meta.email?.source).toBe("shopify");
    expect(meta.phone?.source).toBe("shopify");

    // El helper NO emite Inngest event de sync a Whaapy — eso es
    // responsabilidad del customers/create flow, no del order flow.
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("missing_phone = true si el customer no trae phone normalizable", async () => {
    const normalized = makeNormalizedCustomer({
      phone: null,
      email: "sinphone@example.com",
    });

    const result = await withTenantContext(ORG, async () => {
      return hydrateContactFromEmbeddedShopifyCustomer(
        normalized,
        "2026-05-15T10:00:00Z",
      );
    });

    expect(result.phone).toBe(null);
    expect(result.missing_phone).toBe(true);
    expect(result.full_name).toBe("Ana Pérez");
    expect(result.email).toBe("sinphone@example.com");
  });

  it("customer sin datos (solo id) no truena — equivale al comportamiento legacy", async () => {
    const normalized = makeNormalizedCustomer({
      fullName: null,
      email: null,
      phone: null,
      address: null,
      tags: [],
      state: null,
      note: null,
    });

    const result = await withTenantContext(ORG, async () => {
      return hydrateContactFromEmbeddedShopifyCustomer(
        normalized,
        "2026-05-15T10:00:00Z",
      );
    });

    expect(result.shopify_customer_id).toBe("10014784815380");
    expect(result.full_name).toBe(null);
    expect(result.email).toBe(null);
    expect(result.phone).toBe(null);
    expect(result.missing_phone).toBe(true);
  });

  it("enlaza identidad cuando ya existe un contact local que matchea por phone (initial match)", async () => {
    // Pre-seed: contact creado desde Whaapy con phone normalizado +
    // sin shopify_customer_id todavía.
    fake.setTable("contacts", [
      {
        id: "contact-existing",
        organization_id: ORG,
        full_name: "Ana P.", // valor "viejo" — Shopify gana en initial match
        email: null,
        phone: "+525555555555",
        address: null,
        internal_note: null,
        shopify_tags: [],
        shopify_state: null,
        assigned_advisor_id: null,
        shopify_customer_id: null,
        whaapy_contact_id: "wh-abc",
        field_metadata: {} as Json,
        last_modified_at: "2026-05-01T00:00:00Z",
        last_modified_source: "whaapy",
        missing_phone: false,
        deleted_in_shopify: false,
        deleted_in_whaapy: false,
        anonymized_at: null,
        last_whaapy_activity_at: null,
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-05-01T00:00:00Z",
      },
    ]);

    const normalized = makeNormalizedCustomer({ fullName: "Ana Pérez" });

    const result = await withTenantContext(ORG, async () => {
      return hydrateContactFromEmbeddedShopifyCustomer(
        normalized,
        "2026-05-15T10:00:00Z",
      );
    });

    // Mismo contacto — no se creó duplicado
    expect(result.id).toBe("contact-existing");
    // Identidad enlazada
    expect(result.shopify_customer_id).toBe("10014784815380");
    expect(result.whaapy_contact_id).toBe("wh-abc");
    // Initial match: Shopify gana sobre valor existente
    expect(result.full_name).toBe("Ana Pérez");
    // Email entra (no existía en el contact local)
    expect(result.email).toBe("ana@example.com");

    // Confirmar que no se insertó un segundo contact
    expect(fake.getTable("contacts")).toHaveLength(1);
  });

  it("no sobrescribe valor más reciente con valor más viejo (LWW por campo)", async () => {
    // Pre-seed: contact con `full_name` actualizado por Whaapy hace
    // muy poco; Shopify llega con updated_at más viejo.
    fake.setTable("contacts", [
      {
        id: "contact-newer",
        organization_id: ORG,
        full_name: "Ana Pérez (Whaapy más nuevo)",
        email: "old@example.com",
        phone: "+525555555555",
        address: null,
        internal_note: null,
        shopify_tags: [],
        shopify_state: null,
        assigned_advisor_id: null,
        shopify_customer_id: "10014784815380",
        whaapy_contact_id: "wh-1",
        field_metadata: {
          full_name: { updated_at: "2026-06-01T10:00:00Z", source: "whaapy" },
          email: { updated_at: "2026-06-01T10:00:00Z", source: "whaapy" },
        } as Json,
        last_modified_at: "2026-06-01T10:00:00Z",
        last_modified_source: "whaapy",
        missing_phone: false,
        deleted_in_shopify: false,
        deleted_in_whaapy: false,
        anonymized_at: null,
        last_whaapy_activity_at: null,
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-06-01T10:00:00Z",
      },
    ]);

    // Order viejo: updated_at del customer es ANTERIOR al Whaapy update
    const normalized = makeNormalizedCustomer({
      fullName: "Ana Vieja",
      email: "stale@example.com",
      updatedAt: "2026-05-15T10:00:00Z",
    });

    const result = await withTenantContext(ORG, async () => {
      return hydrateContactFromEmbeddedShopifyCustomer(
        normalized,
        "2026-05-15T10:00:00Z",
      );
    });

    // LWW preservó el valor más reciente (Whaapy)
    expect(result.full_name).toBe("Ana Pérez (Whaapy más nuevo)");
    expect(result.email).toBe("old@example.com");
  });
});
