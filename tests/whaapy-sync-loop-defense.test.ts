import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Defensa anti-bucle R11 desde el lado Whaapy (M4):
 *   - Opción B: el webhook contact.updated con timestamp dentro de
 *     la ventana echo (30s) y last_modified_source='platform' → descarte.
 *   - Identidad de la marca local: idéntica al patrón Shopify, lo
 *     que valida es que discardIfOwnEcho registra audit log con
 *     source='whaapy'.
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

import { withTenantContext } from "@/lib/tenant/context";
import {
  discardIfOwnEcho,
  markOutboundWrite,
} from "@/lib/services/sync-loop-defense";

const ORG = "org-1";
const CONTACT_ID = "contact-1";

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

beforeEach(() => {
  fake.reset();
});

describe("R11 — defensa anti-bucle desde Whaapy (M4)", () => {
  it("descarta webhook eco con audit log source=whaapy", async () => {
    const now = new Date();
    seedContact({
      lastModifiedAt: now.toISOString(),
      lastModifiedSource: "platform",
    });
    await withTenantContext(ORG, async () => {
      const isEcho = await discardIfOwnEcho({
        contactId: CONTACT_ID,
        payloadUpdatedAt: new Date(now.getTime() + 1000).toISOString(),
        source: "whaapy",
        whaapyEntityId: "wh-1",
      });
      expect(isEcho).toBe(true);
    });
    const audit = fake.getTable("audit_log");
    const sl = audit.find((a) => a.event_type === "sync_loop_prevented");
    expect(sl).toBeDefined();
    const payload = (sl as { payload: { source: string; whaapy_entity_id: string } }).payload;
    expect(payload.source).toBe("whaapy");
    expect(payload.whaapy_entity_id).toBe("wh-1");
  });

  it("loop sintético outbound → webhook eco → descarte (no procesar)", async () => {
    seedContact({ lastModifiedAt: "2026-01-01T00:00:00Z", lastModifiedSource: "shopify" });
    await withTenantContext(ORG, async () => {
      // 1. La plataforma escribe outbound a Whaapy
      await markOutboundWrite({ contactId: CONTACT_ID, source: "centrhub" });
      // 2. Whaapy hace eco con timestamp casi idéntico
      const localTs = fake.getTable("contacts")[0].last_modified_at as string;
      const echoTs = new Date(new Date(localTs).getTime() + 500).toISOString();
      const isEcho = await discardIfOwnEcho({
        contactId: CONTACT_ID,
        payloadUpdatedAt: echoTs,
        source: "whaapy",
        whaapyEntityId: "wh-2",
      });
      expect(isEcho).toBe(true);
    });
    const audit = fake.getTable("audit_log");
    expect(audit.filter((a) => a.event_type === "sync_loop_prevented").length).toBe(1);
  });

  it("NO descarta si el webhook llega después de 30s (fuera de ventana)", async () => {
    const veryOld = new Date(Date.now() - 5 * 60_000);
    seedContact({
      lastModifiedAt: veryOld.toISOString(),
      lastModifiedSource: "platform",
    });
    await withTenantContext(ORG, async () => {
      const isEcho = await discardIfOwnEcho({
        contactId: CONTACT_ID,
        payloadUpdatedAt: new Date().toISOString(),
        source: "whaapy",
      });
      expect(isEcho).toBe(false);
    });
  });
});
