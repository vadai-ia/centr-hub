import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * MENSAJE 1 — servicio que mueve el contacto en el funnel de VENTA para que
 * su Automation mande la confirmación de entrega.
 *
 * Lo que protegen estos tests:
 *   - **Anti-duplicado**: el trigger de Whaapy es ENTRAR a la etapa. Si el
 *     contacto ya está ahí, re-moverlo le manda al cliente el mensaje otra
 *     vez. Ni siquiera se escriben los custom_fields (ese PATCH rebota por
 *     webhook en esta instancia).
 *   - **El número que ve el cliente** es el del PEDIDO, no el del borrador.
 *   - **Caminos "no aplica"** que NO deben lanzar (reintentar no ayuda).
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdminClient: () => fake }));

vi.mock("@/lib/whaapy/funnel", () => ({
  resolveVentaStageIdByKey: vi.fn(),
  getVentaContactStageId: vi.fn(),
  findVentaContactByPhone: vi.fn(),
  patchVentaContactCustomFields: vi.fn().mockResolvedValue(undefined),
  moveVentaContactToStage: vi.fn().mockResolvedValue(undefined),
}));

import { withTenantContext } from "@/lib/tenant/context";
import { pushVentaDeliveryMessage } from "@/lib/whaapy/venta-delivery-push";
import {
  resolveVentaStageIdByKey,
  getVentaContactStageId,
  findVentaContactByPhone,
  patchVentaContactCustomFields,
  moveVentaContactToStage,
} from "@/lib/whaapy/funnel";

const mock = <T extends (...a: never[]) => unknown>(fn: T) =>
  fn as unknown as ReturnType<typeof vi.fn>;

const ORG = "org-1";
const STAGE = "venta-stage-entregado";
const WHAAPY_ID = "wc-venta-1";

function seedOpp(overrides: Record<string, unknown> = {}) {
  fake.setTable("opportunities", [
    {
      id: "opp-1",
      organization_id: ORG,
      funnel: "post_venta",
      contact_id: "contact-1",
      display_reference: "#D903",
      shopify_order_id: "gid://shopify/Order/999",
      last_modified_at: "2026-06-01T00:00:00Z",
      ...overrides,
    },
  ]);
}

function seedContact(whaapyContactId: string | null) {
  fake.setTable("contacts", [
    {
      id: "contact-1",
      organization_id: ORG,
      phone: "+525512345678",
      full_name: "Cliente Prueba",
      email: null,
      whaapy_contact_id: whaapyContactId,
    },
  ]);
}

function seedOrder(shopifyName: string | null = "#1759") {
  fake.setTable("orders", [
    {
      id: "order-1",
      organization_id: ORG,
      shopify_order_id: "gid://shopify/Order/999",
      shopify_name: shopifyName,
    },
  ]);
}

const push = () =>
  withTenantContext(
    ORG,
    () => pushVentaDeliveryMessage({ organizationId: ORG, opportunityId: "opp-1" }),
    { source: "worker" },
  );

const auditTypes = (): string[] =>
  fake.getTable("audit_log").map((a) => (a as { event_type: string }).event_type);

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  mock(resolveVentaStageIdByKey).mockResolvedValue(STAGE);
  mock(getVentaContactStageId).mockResolvedValue("otra-etapa");
});

describe("pushVentaDeliveryMessage", () => {
  it("camino feliz: escribe el nº de PEDIDO y mueve a Entregado", async () => {
    seedOpp();
    seedOrder("#1759");
    seedContact(WHAAPY_ID);

    const r = await push();

    expect(r).toEqual({ ok: true, moved: true, whaapyContactId: WHAAPY_ID });
    const [, , fields] = mock(patchVentaContactCustomFields).mock.calls[0];
    expect((fields as Record<string, unknown>).centrhub_order_ref).toBe("1759");
    expect((fields as Record<string, unknown>).centrhub_order_ref).not.toBe("#D903");
    // sin "#": la plantilla ya lo trae en su texto fijo
    expect((fields as Record<string, unknown>).centrhub_order_ref).not.toBe("#1759");
    expect(moveVentaContactToStage).toHaveBeenCalledWith(ORG, WHAAPY_ID, STAGE);
    expect(auditTypes()).toContain("venta_delivery_message_pushed");
  });

  it("anti-duplicado: ya está en Entregado → no mueve NI escribe", async () => {
    seedOpp();
    seedOrder();
    seedContact(WHAAPY_ID);
    mock(getVentaContactStageId).mockResolvedValue(STAGE);

    const r = await push();

    expect(r).toEqual({ ok: true, moved: false, whaapyContactId: WHAAPY_ID });
    expect(moveVentaContactToStage).not.toHaveBeenCalled();
    // El PATCH también se salta: en esta instancia rebota como contact.updated.
    expect(patchVentaContactCustomFields).not.toHaveBeenCalled();
    expect(auditTypes()).toContain("venta_delivery_already_in_stage");
  });


  it("etapa inexistente en el funnel de Venta → skip + audit (config pendiente)", async () => {
    seedOpp();
    seedOrder();
    seedContact(WHAAPY_ID);
    mock(resolveVentaStageIdByKey).mockResolvedValue(null);

    const r = await push();

    expect(r).toEqual({ ok: false, skipped: "stage_unresolved" });
    expect(moveVentaContactToStage).not.toHaveBeenCalled();
    expect(auditTypes()).toContain("venta_delivery_stage_unresolved");
  });

  it("sin orden enlazada: mueve igual, pero audita que la variable irá vacía", async () => {
    seedOpp({ shopify_order_id: null });
    seedContact(WHAAPY_ID);

    const r = await push();

    expect(r).toMatchObject({ ok: true, moved: true });
    const [, , fields] = mock(patchVentaContactCustomFields).mock.calls[0];
    expect((fields as Record<string, unknown>).centrhub_order_ref).toBeNull();
    expect(auditTypes()).toContain("venta_delivery_order_ref_missing");
  });

  it("contacto inexistente → skip sin lanzar", async () => {
    seedOpp({ contact_id: null });
    seedOrder();

    const r = await push();

    expect(r).toEqual({ ok: false, skipped: "contact_not_found" });
  });

  // --- Rescate por teléfono ---------------------------------------------
  // Solo el 13% de los contactos trae whaapy_contact_id, así que esta rama
  // NO es un caso borde: es el camino habitual.

  it("sin id local: lo busca por teléfono, lo enlaza y mueve", async () => {
    seedOpp();
    seedOrder("#1759");
    seedContact(null);
    mock(findVentaContactByPhone).mockResolvedValue({ contactId: "wc-hallado", currentStageId: null });

    const r = await push();

    expect(r).toEqual({ ok: true, moved: true, whaapyContactId: "wc-hallado" });
    expect(findVentaContactByPhone).toHaveBeenCalledWith(ORG, "+525512345678");
    expect(moveVentaContactToStage).toHaveBeenCalledWith(ORG, "wc-hallado", STAGE);
    // backfill: la próxima entrega ya no paga la búsqueda
    const saved = fake.getTable("contacts")[0] as Record<string, unknown>;
    expect(saved.whaapy_contact_id).toBe("wc-hallado");
    expect(auditTypes()).toContain("venta_delivery_contact_linked_by_phone");
  });

  it("rescate: la búsqueda ya trae la etapa → anti-duplicado sin GET extra", async () => {
    seedOpp();
    seedOrder();
    seedContact(null);
    mock(findVentaContactByPhone).mockResolvedValue({ contactId: "wc-hallado", currentStageId: STAGE });

    const r = await push();

    expect(r).toEqual({ ok: true, moved: false, whaapyContactId: "wc-hallado" });
    expect(getVentaContactStageId).not.toHaveBeenCalled();
    expect(moveVentaContactToStage).not.toHaveBeenCalled();
  });

  it("no existe en Whaapy: skip con motivo propio y NO lo crea", async () => {
    seedOpp();
    seedOrder();
    seedContact(null);
    mock(findVentaContactByPhone).mockResolvedValue(null);

    const r = await push();

    expect(r).toEqual({ ok: false, skipped: "contact_not_in_whaapy" });
    expect(moveVentaContactToStage).not.toHaveBeenCalled();
    expect(auditTypes()).toContain("venta_delivery_contact_not_in_whaapy");
  });

  it("sin id local NI teléfono: skip por missing_phone, sin buscar", async () => {
    seedOpp();
    seedOrder();
    fake.setTable("contacts", [
      { id: "contact-1", organization_id: ORG, phone: null, full_name: "X", email: null, whaapy_contact_id: null },
    ]);

    const r = await push();

    expect(r).toEqual({ ok: false, skipped: "missing_phone" });
    expect(findVentaContactByPhone).not.toHaveBeenCalled();
  });
});
