import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * FASE 1 — servicio de PUSH de etapa al Whaapy de Post-venta.
 * Verifica: match por teléfono, escritura de custom_fields con el opp_id
 * (match inverso), anti-bucle capa 2 (saltar move si ya está en la etapa),
 * y los caminos "registrar y no romper" (sin teléfono / sin match).
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

// La capa API contra Whaapy se mockea — acá probamos la orquestación.
vi.mock("@/lib/whaapy-postventa/api", () => ({
  resolvePostventaStageIdByKey: vi.fn(),
  findPostventaContactByPhone: vi.fn(),
  patchPostventaContactCustomFields: vi.fn().mockResolvedValue(undefined),
  movePostventaContactToStage: vi.fn().mockResolvedValue(undefined),
}));

import { withTenantContext } from "@/lib/tenant/context";
import { pushPostventaStage } from "@/lib/whaapy-postventa/push-service";
import {
  resolvePostventaStageIdByKey,
  findPostventaContactByPhone,
  patchPostventaContactCustomFields,
  movePostventaContactToStage,
} from "@/lib/whaapy-postventa/api";

const ORG = "org-1";
const STAGE = "whaapy-stage-entregado";

function seedOpp(overrides: Record<string, unknown> = {}) {
  fake.setTable("opportunities", [
    {
      id: "opp-1",
      organization_id: ORG,
      funnel: "post_venta",
      contact_id: "contact-1",
      display_reference: "#1234",
      shopify_order_id: "gid://shopify/Order/999",
      last_modified_at: "2026-06-01T00:00:00Z",
      ...overrides,
    },
  ]);
}

function seedContact(phone: string | null) {
  fake.setTable("contacts", [
    { id: "contact-1", organization_id: ORG, phone },
  ]);
}

const run = <T>(fn: () => Promise<T>) =>
  withTenantContext(ORG, fn, { source: "worker" });

const push = () =>
  run(() =>
    pushPostventaStage({
      organizationId: ORG,
      opportunityId: "opp-1",
      target: "entregado",
    }),
  );

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  (resolvePostventaStageIdByKey as ReturnType<typeof vi.fn>).mockResolvedValue(STAGE);
});

describe("pushPostventaStage", () => {
  it("happy path: escribe custom_fields con opp_id/order + mueve de etapa", async () => {
    seedOpp();
    seedContact("+525512345678");
    (findPostventaContactByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({
      contactId: "wc-1",
      currentStageId: "otra-etapa",
    });

    const r = await push();

    expect(r).toEqual({ ok: true, moved: true, whaapyContactId: "wc-1" });
    expect(patchPostventaContactCustomFields).toHaveBeenCalledWith(ORG, "wc-1", {
      centrhub_opportunity_id: "opp-1",
      centrhub_order_ref: "#1234",
      centrhub_order_id: "gid://shopify/Order/999",
    });
    expect(movePostventaContactToStage).toHaveBeenCalledWith(ORG, "wc-1", STAGE);
    const audits = fake.getTable("audit_log");
    expect(
      audits.some(
        (a) => (a as { event_type: string }).event_type === "postventa_whaapy_stage_pushed",
      ),
    ).toBe(true);
  });

  it("anti-bucle capa 2: si ya está en la etapa destino, NO mueve", async () => {
    seedOpp();
    seedContact("+525512345678");
    (findPostventaContactByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({
      contactId: "wc-1",
      currentStageId: STAGE, // ya está en Entregado
    });

    const r = await push();

    expect(r).toEqual({ ok: true, moved: false, whaapyContactId: "wc-1" });
    expect(patchPostventaContactCustomFields).toHaveBeenCalledTimes(1);
    expect(movePostventaContactToStage).not.toHaveBeenCalled();
  });

  it("sin match en Whaapy → registrar y no romper (no PATCH, no move)", async () => {
    seedOpp();
    seedContact("+525512345678");
    (findPostventaContactByPhone as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const r = await push();

    expect(r).toEqual({ ok: false, skipped: "no_whaapy_match" });
    expect(patchPostventaContactCustomFields).not.toHaveBeenCalled();
    expect(movePostventaContactToStage).not.toHaveBeenCalled();
    const audits = fake.getTable("audit_log");
    expect(
      audits.some((a) => (a as { event_type: string }).event_type === "postventa_whaapy_no_match"),
    ).toBe(true);
  });

  it("contacto sin teléfono → missing_phone, sin resolver etapa ni buscar", async () => {
    seedOpp();
    seedContact(null);

    const r = await push();

    expect(r).toEqual({ ok: false, skipped: "missing_phone" });
    expect(resolvePostventaStageIdByKey).not.toHaveBeenCalled();
    expect(findPostventaContactByPhone).not.toHaveBeenCalled();
  });

  it("etapa no resuelta en Whaapy → stage_unresolved, sin buscar contacto", async () => {
    seedOpp();
    seedContact("+525512345678");
    (resolvePostventaStageIdByKey as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const r = await push();

    expect(r).toEqual({ ok: false, skipped: "stage_unresolved" });
    expect(findPostventaContactByPhone).not.toHaveBeenCalled();
  });
});
