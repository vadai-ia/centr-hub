import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

import { withTenantContext } from "@/lib/tenant/context";
import {
  checkInboundIsOwnEcho,
  discardIfOwnEcho,
  markOutboundWrite,
} from "@/lib/services/sync-loop-defense";

const ORG = "org-1";
const CONTACT_ID = "contact-1";

beforeEach(() => {
  fake.reset();
});

function seedContact(opts: { lastModifiedAt: string; lastModifiedSource: string }) {
  fake.setTable("contacts", [
    {
      id: CONTACT_ID,
      organization_id: ORG,
      last_modified_at: opts.lastModifiedAt,
      last_modified_source: opts.lastModifiedSource,
    },
  ]);
}

describe("R11 — defensa anti-bucle (Sección CLAUDE.md + R11)", () => {
  it("markOutboundWrite marca contact con source=platform y timestamp", async () => {
    seedContact({ lastModifiedAt: "2026-01-01T00:00:00Z", lastModifiedSource: "shopify" });
    await withTenantContext(ORG, async () => {
      await markOutboundWrite({ contactId: CONTACT_ID, source: "centrhub" });
    });
    const updated = fake.getTable("contacts")[0];
    expect(updated.last_modified_source).toBe("platform");
    // last_modified_at debe ser muy reciente (cerca de NOW)
    const delta = Date.now() - new Date(updated.last_modified_at as string).getTime();
    expect(delta).toBeLessThan(2000);
  });

  it("detecta eco cuando webhook llega después de marca outbound (timestamps cercanos)", async () => {
    const now = new Date();
    seedContact({
      lastModifiedAt: now.toISOString(),
      lastModifiedSource: "platform",
    });
    await withTenantContext(ORG, async () => {
      const result = await checkInboundIsOwnEcho({
        contactId: CONTACT_ID,
        payloadUpdatedAt: new Date(now.getTime() + 2000).toISOString(), // 2s después
      });
      expect(result.isOwnEcho).toBe(true);
      expect(result.reason).toBe("own_echo_detected");
    });
  });

  it("NO descarta si la marca local es de Shopify (no es eco propio)", async () => {
    seedContact({
      lastModifiedAt: new Date().toISOString(),
      lastModifiedSource: "shopify",
    });
    await withTenantContext(ORG, async () => {
      const result = await checkInboundIsOwnEcho({
        contactId: CONTACT_ID,
        payloadUpdatedAt: new Date().toISOString(),
      });
      expect(result.isOwnEcho).toBe(false);
      expect(result.reason).toBe("marker_mismatch");
    });
  });

  it("NO descarta si el webhook llega fuera de la ventana de eco (30s)", async () => {
    const veryOld = new Date(Date.now() - 5 * 60_000); // 5 min antes
    seedContact({
      lastModifiedAt: veryOld.toISOString(),
      lastModifiedSource: "platform",
    });
    await withTenantContext(ORG, async () => {
      const result = await checkInboundIsOwnEcho({
        contactId: CONTACT_ID,
        payloadUpdatedAt: new Date().toISOString(),
      });
      expect(result.isOwnEcho).toBe(false);
      expect(result.reason).toBe("outside_window");
    });
  });

  it("discardIfOwnEcho registra audit log sync_loop_prevented cuando detecta eco", async () => {
    const now = new Date();
    seedContact({
      lastModifiedAt: now.toISOString(),
      lastModifiedSource: "platform",
    });
    await withTenantContext(ORG, async () => {
      const isEcho = await discardIfOwnEcho({
        contactId: CONTACT_ID,
        payloadUpdatedAt: new Date(now.getTime() + 1000).toISOString(),
        source: "shopify",
        shopifyEntityId: "shopify-cid-1",
      });
      expect(isEcho).toBe(true);
      const audit = fake.getTable("audit_log");
      const sl = audit.find((a) => a.event_type === "sync_loop_prevented");
      expect(sl).toBeDefined();
      expect((sl as { payload: { source: string } }).payload.source).toBe("shopify");
    });
  });

  it("loop sintético completo: outbound → webhook eco → descarte (no procesar)", async () => {
    seedContact({ lastModifiedAt: "2026-01-01T00:00:00Z", lastModifiedSource: "shopify" });
    await withTenantContext(ORG, async () => {
      // 1. La plataforma escribe outbound
      await markOutboundWrite({ contactId: CONTACT_ID, source: "centrhub" });
      // 2. Shopify hace eco con timestamp casi idéntico
      const localTs = fake.getTable("contacts")[0].last_modified_at as string;
      const echoTs = new Date(new Date(localTs).getTime() + 500).toISOString();
      const isEcho = await discardIfOwnEcho({
        contactId: CONTACT_ID,
        payloadUpdatedAt: echoTs,
        source: "shopify",
      });
      expect(isEcho).toBe(true);
      // 3. No habría re-aplicación del cambio — corte limpio.
      const audit = fake.getTable("audit_log");
      expect(audit.filter((a) => a.event_type === "sync_loop_prevented").length).toBe(1);
    });
  });
});
