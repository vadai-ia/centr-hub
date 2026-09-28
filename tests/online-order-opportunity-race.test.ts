import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Carrera de webhooks sobre la MISMA compra online.
 *
 * Los webhooks `orders/*` de un pedido llegan casi simultáneos. La guarda
 * `orders.opportunity_id` lee y después escribe, así que por sí sola deja
 * pasar a los tres competidores (medido en producción: tres tarjetas del
 * mismo pedido en 241 ms). Aquí se protegen las dos capas que cierran esa
 * ventana sin reventar el webhook del perdedor.
 */

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db/opportunities", () => ({ createOpportunity: vi.fn() }));
vi.mock("@/lib/db/orders", () => ({ getOrderById: vi.fn(), updateOrder: vi.fn() }));
vi.mock("@/lib/db/operational", () => ({ recordAuditEvent: vi.fn() }));
vi.mock("@/lib/services/postventa-transition", () => ({
  resolvePostventaEngineStages: vi.fn(),
}));

import { ensureOnlineOrderOpportunity } from "@/lib/services/online-order-opportunity";
import { createOpportunity } from "@/lib/db/opportunities";
import { getOrderById, updateOrder } from "@/lib/db/orders";
import { resolvePostventaEngineStages } from "@/lib/services/postventa-transition";
import type { OrderRow } from "@/lib/types/database";

const mock = <T extends (...a: never[]) => unknown>(fn: T) =>
  fn as unknown as ReturnType<typeof vi.fn>;

const ORDER = {
  id: "order-1",
  organization_id: "org-1",
  contact_id: "contact-1",
  opportunity_id: null,
  shopify_order_id: "18911958696212",
  shopify_name: "#1992",
  financial_status: "paid",
  source: "web",
  subtotal: "15300.00",
  currency: "MXN",
  shopify_created_at: "2026-09-27T19:10:50.000Z",
} as OrderRow;

beforeEach(() => {
  vi.clearAllMocks();
  mock(resolvePostventaEngineStages).mockResolvedValue({
    zoneByPosition: { 2: { id: "pv-pago-confirmado", name: "Pago confirmado" } },
  });
  mock(getOrderById).mockResolvedValue({ ...ORDER });
});

describe("compra online — carrera de webhooks", () => {
  it("el pedido ya quedó enlazado mientras el worker lo traía → no crea otra", async () => {
    mock(getOrderById).mockResolvedValue({ ...ORDER, opportunity_id: "opp-ganadora" });

    const res = await ensureOnlineOrderOpportunity(ORDER);

    expect(res).toEqual({ created: false, reason: "already_linked" });
    expect(createOpportunity).not.toHaveBeenCalled();
  });

  it("el índice único (0056) rechaza al perdedor → se traduce, NO revienta el webhook", async () => {
    mock(createOpportunity).mockRejectedValue({ code: "23505" });

    const res = await ensureOnlineOrderOpportunity(ORDER);

    expect(res).toEqual({ created: false, reason: "already_linked" });
    // Clave: el perdedor no re-apunta el pedido a una opp que no existe.
    expect(updateOrder).not.toHaveBeenCalled();
  });

  it("cualquier otro error sí propaga (el webhook debe reintentar)", async () => {
    mock(createOpportunity).mockRejectedValue({ code: "57014", message: "timeout" });

    await expect(ensureOnlineOrderOpportunity(ORDER)).rejects.toMatchObject({
      code: "57014",
    });
  });

  it("el ganador crea, enlaza y devuelve su opp", async () => {
    mock(createOpportunity).mockResolvedValue({ id: "opp-nueva" });

    const res = await ensureOnlineOrderOpportunity(ORDER);

    expect(res).toEqual({ created: true, opportunityId: "opp-nueva" });
    expect(updateOrder).toHaveBeenCalledWith("order-1", { opportunity_id: "opp-nueva" });
  });
});
