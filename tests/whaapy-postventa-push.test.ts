import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * FASE 1/rev — servicio de PUSH de etapa al Whaapy de Post-venta.
 * Verifica: match por teléfono, escritura de custom_fields con el opp_id,
 * anti-bucle capa 2 (saltar move si ya está en la etapa), AUTO-CREACIÓN del
 * contacto cuando no existe (crear → mover), y los caminos "no aplica"
 * (sin teléfono / etapa no resuelta).
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

// La capa API contra Whaapy se mockea — acá probamos la orquestación.
vi.mock("@/lib/whaapy-postventa/api", () => ({
  resolvePostventaStageIdByKey: vi.fn(),
  findPostventaContactByPhone: vi.fn(),
  createPostventaContact: vi.fn(),
  patchPostventaContactCustomFields: vi.fn().mockResolvedValue(undefined),
  movePostventaContactToStage: vi.fn().mockResolvedValue(undefined),
}));

import { withTenantContext } from "@/lib/tenant/context";
import { pushPostventaStage } from "@/lib/whaapy-postventa/push-service";
import {
  resolvePostventaStageIdByKey,
  findPostventaContactByPhone,
  createPostventaContact,
  patchPostventaContactCustomFields,
  movePostventaContactToStage,
} from "@/lib/whaapy-postventa/api";

const mock = <T extends (...a: never[]) => unknown>(fn: T) =>
  fn as unknown as ReturnType<typeof vi.fn>;

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
    { id: "contact-1", organization_id: ORG, phone, full_name: "Cliente Prueba", email: "cliente@test.mx" },
  ]);
}

const run = <T>(fn: () => Promise<T>) =>
  withTenantContext(ORG, fn, { source: "worker" });

const push = () =>
  run(() =>
    pushPostventaStage({ organizationId: ORG, opportunityId: "opp-1", target: "entregado" }),
  );

function auditTypes(): string[] {
  return fake.getTable("audit_log").map((a) => (a as { event_type: string }).event_type);
}

const CUSTOM_FIELDS = {
  centrhub_opportunity_id: "opp-1",
  centrhub_order_ref: "#1234",
  centrhub_order_id: "gid://shopify/Order/999",
};

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  mock(resolvePostventaStageIdByKey).mockResolvedValue(STAGE);
});

describe("pushPostventaStage", () => {
  it("contacto EXISTE: PATCH custom_fields + move", async () => {
    seedOpp();
    seedContact("+525512345678");
    mock(findPostventaContactByPhone).mockResolvedValue({ contactId: "wc-1", currentStageId: "otra" });

    const r = await push();

    expect(r).toEqual({ ok: true, moved: true, created: false, whaapyContactId: "wc-1" });
    expect(patchPostventaContactCustomFields).toHaveBeenCalledWith(ORG, "wc-1", CUSTOM_FIELDS);
    expect(createPostventaContact).not.toHaveBeenCalled();
    expect(movePostventaContactToStage).toHaveBeenCalledWith(ORG, "wc-1", STAGE);
    expect(auditTypes()).toContain("postventa_whaapy_stage_pushed");
  });

  it("anti-bucle capa 2: contacto existente ya en la etapa destino → NO mueve", async () => {
    seedOpp();
    seedContact("+525512345678");
    mock(findPostventaContactByPhone).mockResolvedValue({ contactId: "wc-1", currentStageId: STAGE });

    const r = await push();

    expect(r).toEqual({ ok: true, moved: false, created: false, whaapyContactId: "wc-1" });
    expect(movePostventaContactToStage).not.toHaveBeenCalled();
  });

  it("contacto NO existe → lo CREA (name+phone+email+custom_fields) y luego mueve", async () => {
    seedOpp();
    seedContact("+525512345678");
    mock(findPostventaContactByPhone).mockResolvedValue(null);
    mock(createPostventaContact).mockResolvedValue("wc-new");

    const r = await push();

    expect(r).toEqual({ ok: true, moved: true, created: true, whaapyContactId: "wc-new" });
    expect(createPostventaContact).toHaveBeenCalledWith(ORG, {
      name: "Cliente Prueba",
      phoneE164: "+525512345678",
      email: "cliente@test.mx",
      customFields: CUSTOM_FIELDS,
    });
    // custom_fields van en el create → no se hace PATCH extra.
    expect(patchPostventaContactCustomFields).not.toHaveBeenCalled();
    // Recién creado (sin etapa) → siempre se mueve.
    expect(movePostventaContactToStage).toHaveBeenCalledWith(ORG, "wc-new", STAGE);
    const types = auditTypes();
    expect(types).toContain("postventa_whaapy_contact_created");
    expect(types).toContain("postventa_whaapy_stage_pushed");
  });

  it("contacto sin teléfono → missing_phone, sin resolver etapa ni buscar/crear", async () => {
    seedOpp();
    seedContact(null);

    const r = await push();

    expect(r).toEqual({ ok: false, skipped: "missing_phone" });
    expect(resolvePostventaStageIdByKey).not.toHaveBeenCalled();
    expect(findPostventaContactByPhone).not.toHaveBeenCalled();
    expect(createPostventaContact).not.toHaveBeenCalled();
  });

  it("etapa no resuelta en Whaapy → stage_unresolved, sin buscar contacto", async () => {
    seedOpp();
    seedContact("+525512345678");
    mock(resolvePostventaStageIdByKey).mockResolvedValue(null);

    const r = await push();

    expect(r).toEqual({ ok: false, skipped: "stage_unresolved" });
    expect(findPostventaContactByPhone).not.toHaveBeenCalled();
  });
});
