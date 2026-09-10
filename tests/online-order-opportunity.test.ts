import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Oportunidad de Post-venta para compras ONLINE (sin Draft Order).
 *
 * Lo que protegen estos tests:
 *   1. **No duplicar.** Los webhooks de un mismo pedido llegan varias veces
 *      (create, updated, paid, fulfilled). Sin la guarda, cada uno crearía
 *      una card y Post-venta vería el mismo pedido cuatro veces.
 *   2. **Solo lo que de verdad es venta online.** El criterio es
 *      `orders.source = 'web'`, NUNCA "no tiene asesor": medido en producción,
 *      la mayoría de los pedidos sin asesor son cotizaciones sin etiquetar.
 *   3. **Nace donde Post-venta lo pidió**, sin asesor y en "Pago confirmado".
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdminClient: () => fake }));

vi.mock("@/lib/services/postventa-transition", () => ({
  resolvePostventaEngineStages: vi.fn(),
}));

import { withTenantContext } from "@/lib/tenant/context";
import { ensureOnlineOrderOpportunity } from "@/lib/services/online-order-opportunity";
import { resolvePostventaEngineStages } from "@/lib/services/postventa-transition";
import type { OrderRow } from "@/lib/types/database";

const mock = <T extends (...a: never[]) => unknown>(fn: T) =>
  fn as unknown as ReturnType<typeof vi.fn>;

const ORG = "org-1";
const PAGO_CONFIRMADO = "pv-pago-confirmado";

function order(over: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "order-1",
    organization_id: ORG,
    contact_id: "contact-1",
    assigned_advisor_id: null,
    opportunity_id: null,
    shopify_order_id: "gid://shopify/Order/999",
    shopify_name: "#1950",
    financial_status: "paid",
    source: "web",
    total_amount: "4300.00",
    currency: "MXN",
    shopify_created_at: "2026-09-10T01:29:19.000Z",
    ...over,
  } as OrderRow;
}

function seedOrder(o: OrderRow) {
  fake.setTable("orders", [o as unknown as Record<string, unknown>]);
}

const run = (o: OrderRow) =>
  withTenantContext(ORG, () => ensureOnlineOrderOpportunity(o), { source: "worker" });

const opps = () => fake.getTable("opportunities");
const savedOrder = () => fake.getTable("orders")[0] as Record<string, unknown>;

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  mock(resolvePostventaEngineStages).mockResolvedValue({
    zoneByPosition: {
      1: { id: "pv-cotizacion", name: "Cotización completada" },
      2: { id: PAGO_CONFIRMADO, name: "Pago confirmado" },
      3: { id: "pv-envio", name: "Envío en curso" },
      4: { id: "pv-entregado", name: "Entregado" },
    },
    zoneStageIds: new Set(),
    problematicStage: { id: "pv-problema" },
  });
});

describe("compra online — creación", () => {
  it("crea la opp en Pago confirmado, sin asesor y con el pedido enlazado", async () => {
    const o = order();
    seedOrder(o);

    const r = await run(o);

    expect(r).toMatchObject({ created: true });
    expect(opps()).toHaveLength(1);
    const created = opps()[0] as Record<string, unknown>;
    expect(created.funnel).toBe("post_venta");
    expect(created.stage_id).toBe(PAGO_CONFIRMADO);
    expect(created.assigned_advisor_id).toBeNull();
    expect(created.shopify_order_id).toBe("gid://shopify/Order/999");
    // Sin borrador: la card enseña el folio del pedido, resuelto de orders.
    expect(created.display_reference).toBeNull();
    expect(created.actual_amount).toBe("4300.00");
  });

  it("enlaza la opp al pedido — es lo que hace idempotente al siguiente webhook", async () => {
    const o = order();
    seedOrder(o);

    const r = await run(o);

    expect(r).toMatchObject({ created: true });
    expect(savedOrder().opportunity_id).toBe((opps()[0] as Record<string, unknown>).id);
  });

  it("conserva la fecha REAL del pedido en Shopify, no la de ingesta", async () => {
    const o = order();
    seedOrder(o);

    await run(o);

    expect((opps()[0] as Record<string, unknown>).shopify_created_at).toBe(
      "2026-09-10T01:29:19.000Z",
    );
  });
});

describe("compra online — no duplicar", () => {
  it("pedido que ya tiene opp: no crea otra", async () => {
    const o = order({ opportunity_id: "opp-ya-existe" });
    seedOrder(o);

    const r = await run(o);

    expect(r).toEqual({ created: false, reason: "already_linked" });
    expect(opps()).toHaveLength(0);
  });

  it("los webhooks repetidos del mismo pedido crean UNA sola", async () => {
    const o = order();
    seedOrder(o);

    await run(o); // orders/create
    // El segundo webhook lee el pedido ya enlazado (como en producción).
    const relinked = order({ opportunity_id: String(savedOrder().opportunity_id) });
    await run(relinked); // orders/paid
    await run(relinked); // orders/fulfilled

    expect(opps()).toHaveLength(1);
  });
});

describe("compra online — a qué pedidos NO aplica", () => {
  it("una cotización de vendedor (draft order) queda fuera", async () => {
    const o = order({ source: "shopify_draft_order" });
    seedOrder(o);

    const r = await run(o);

    expect(r).toEqual({ created: false, reason: "not_online" });
    expect(opps()).toHaveLength(0);
  });

  it("un pedido online SIN asesor pero que no es 'web' tampoco aplica", async () => {
    // El criterio es el ORIGEN, no la ausencia de asesor.
    const o = order({ source: "pos", assigned_advisor_id: null });
    seedOrder(o);

    expect(await run(o)).toEqual({ created: false, reason: "not_online" });
  });

  it("online pero aún no pagado: espera a que se pague", async () => {
    const o = order({ financial_status: "pending" });
    seedOrder(o);

    const r = await run(o);

    expect(r).toEqual({ created: false, reason: "not_paid" });
    expect(opps()).toHaveLength(0);
  });

  it("sin contacto resuelto: no crea una opp huérfana", async () => {
    const o = order({ contact_id: null as unknown as OrderRow["contact_id"] });
    seedOrder(o);

    expect(await run(o)).toEqual({ created: false, reason: "missing_contact" });
    expect(opps()).toHaveLength(0);
  });

  it("funnel de Post-venta sin la forma esperada: no crea nada", async () => {
    mock(resolvePostventaEngineStages).mockResolvedValue(null);
    const o = order();
    seedOrder(o);

    expect(await run(o)).toEqual({ created: false, reason: "stages_unresolved" });
    expect(opps()).toHaveLength(0);
  });
});
