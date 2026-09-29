import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * MENSAJE 1 — la plataforma ENVÍA la plantilla de confirmación de entrega
 * por la instancia de Venta, con los parámetros ya resueltos.
 *
 * Por qué envía la plataforma y no una Automation de Whaapy: **Whaapy no
 * resuelve campos personalizados como variables de plantilla**. La vía
 * anterior (escribir el folio en un `custom_field` y mover de etapa para que
 * su Automation enviara) abortaba con "la variable no tiene valor" y NO
 * dejaba ni un mensaje fallido en la conversación. Ver
 * `lib/whaapy/send-template.ts`.
 *
 * Lo que protegen estos tests:
 *   - **Anti-duplicado** por `delivery_message_sent_at`: al cliente se le
 *     escribe UNA vez, aunque la opp vuelva a pasar por "Entregado" o
 *     Inngest reintente.
 *   - **El número que ve el cliente** es el del PEDIDO, no el del borrador,
 *     y va SIN `#` (la plantilla ya lo trae en su texto fijo).
 *   - **Sin folio no se manda**: Meta rechaza la plantilla con un parámetro
 *     vacío, y "tu pedido # ha sido entregado" es peor que no escribir.
 *   - **El sello se escribe DESPUÉS del envío**: si el POST falla, la opp no
 *     queda marcada como avisada.
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdminClient: () => fake }));

vi.mock("@/lib/whaapy/send-template", () => ({
  sendVentaTemplate: vi.fn().mockResolvedValue(undefined),
  VENTA_DELIVERY_TEMPLATE: "confirmacion_pedio_entregado",
}));

import { withTenantContext } from "@/lib/tenant/context";
import { pushVentaDeliveryMessage } from "@/lib/whaapy/venta-delivery-push";
import { sendVentaTemplate } from "@/lib/whaapy/send-template";
import type { UUID } from "@/lib/types/database";

const mock = <T extends (...a: never[]) => unknown>(fn: T) =>
  fn as unknown as ReturnType<typeof vi.fn>;

const ORG = "org-1";
const OPP = "opp-1";

function seed(opp: Record<string, unknown> = {}, contact: Record<string, unknown> = {}) {
  fake.setTable("opportunities", [
    {
      id: OPP,
      organization_id: ORG,
      funnel: "post_venta",
      contact_id: "contact-1",
      shopify_order_id: "7026619941140",
      display_reference: "#D903",
      delivery_message_sent_at: null,
      ...opp,
    },
  ]);
  fake.setTable("contacts", [
    {
      id: "contact-1",
      organization_id: ORG,
      full_name: "Pamela Alvarez",
      phone: "+525512345678",
      whaapy_contact_id: null,
      ...contact,
    },
  ]);
  fake.setTable("orders", [
    {
      id: "order-1",
      organization_id: ORG,
      shopify_order_id: "7026619941140",
      shopify_name: "#1759",
      source: "web",
    },
  ]);
  fake.setTable("audit_log", []);
}

const run = () =>
  withTenantContext(
    ORG,
    () => pushVentaDeliveryMessage({ organizationId: ORG as UUID, opportunityId: OPP as UUID }),
    { source: "worker" },
  );

beforeEach(() => {
  vi.clearAllMocks();
  mock(sendVentaTemplate).mockResolvedValue(undefined);
  seed();
});

describe("mensaje de entrega — envío directo", () => {
  it("manda la plantilla con el nombre de pila y el folio del PEDIDO, sin #", async () => {
    const res = await run();

    expect(res).toEqual({ ok: true, sent: true });
    expect(sendVentaTemplate).toHaveBeenCalledWith(ORG, {
      to: "+525512345678",
      templateName: "confirmacion_pedio_entregado",
      // "Pamela", no "Pamela Alvarez"; "1759", no "#1759" ni el borrador "#D903".
      parameters: ["Pamela", "1759"],
    });
  });

  it("sella delivery_message_sent_at para anclar el mensaje de 7 días", async () => {
    await run();

    const opp = fake.getTable("opportunities")[0] as { delivery_message_sent_at: string | null };
    expect(opp.delivery_message_sent_at).toBeTruthy();
  });

  it("no le escribe dos veces al cliente si ya tiene sello", async () => {
    seed({ delivery_message_sent_at: "2026-09-20T10:00:00.000Z" });

    const res = await run();

    expect(res).toEqual({ ok: true, sent: false });
    expect(sendVentaTemplate).not.toHaveBeenCalled();
  });

  it("sin folio NO manda (Meta rechaza el parámetro vacío)", async () => {
    fake.setTable("orders", []);

    const res = await run();

    expect(res).toEqual({ ok: false, skipped: "order_ref_missing" });
    expect(sendVentaTemplate).not.toHaveBeenCalled();
  });

  it("sin teléfono NO lanza: audita y se salta (reintentar no ayuda)", async () => {
    seed({}, { phone: null });

    const res = await run();

    expect(res).toEqual({ ok: false, skipped: "missing_phone" });
    expect(sendVentaTemplate).not.toHaveBeenCalled();
  });

  it("si el envío falla, propaga y NO deja la opp marcada como avisada", async () => {
    mock(sendVentaTemplate).mockRejectedValue(new Error("whaapy_rest_failed: 500"));

    await expect(run()).rejects.toThrow("whaapy_rest_failed");

    const opp = fake.getTable("opportunities")[0] as { delivery_message_sent_at: string | null };
    expect(opp.delivery_message_sent_at).toBeNull();
  });
});
