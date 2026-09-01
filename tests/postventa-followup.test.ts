import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * MENSAJE 2 — seguimiento "7 dias" desde el número de Post-venta.
 *
 * Lo que protegen estos tests, en orden de gravedad:
 *
 *   1. **No duplicar.** Es categoría MARKETING: un segundo envío al mismo
 *      cliente cuesta reputación del número, no solo dinero. El candado es
 *      `followup_message_sent_at` y se sella ANTES de mover la etapa.
 *   2. **No mandárselo a quien tuvo un problema.** El texto pregunta "¿todo
 *      funciona correctamente?" — a alguien con el pedido cancelado,
 *      reembolsado o en caso problemático es el peor mensaje posible.
 *   3. **Contar desde el ENVÍO del mensaje 1**, no desde la entrega.
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdminClient: () => fake }));

vi.mock("@/lib/whaapy-postventa/push-service", () => ({
  pushPostventaStage: vi.fn(),
}));
vi.mock("@/lib/services/dashboard-stages", () => ({
  resolvePostventaStages: vi.fn(),
}));
vi.mock("@/lib/services/pipeline-move", () => ({
  moveOpportunityStage: vi.fn().mockResolvedValue({ ok: true }),
}));

import { withTenantContext } from "@/lib/tenant/context";
import { sendPostventaFollowup } from "@/lib/services/postventa-followup";
import { pushPostventaStage } from "@/lib/whaapy-postventa/push-service";
import { resolvePostventaStages } from "@/lib/services/dashboard-stages";
import { moveOpportunityStage } from "@/lib/services/pipeline-move";

const mock = <T extends (...a: never[]) => unknown>(fn: T) =>
  fn as unknown as ReturnType<typeof vi.fn>;

const ORG = "org-1";
const NOW = "2026-08-21T12:00:00.000Z";
/** 7 días exactos antes de NOW. */
const HACE_7_DIAS = "2026-08-14T12:00:00.000Z";
const HACE_3_DIAS = "2026-08-18T12:00:00.000Z";
const STAGE_SEGUIMIENTO = "pv-seguimiento";
const STAGE_ENTREGADO = "pv-entregado";
const STAGE_PROBLEMA = "pv-problema";

function seedOpp(overrides: Record<string, unknown> = {}) {
  fake.setTable("opportunities", [
    {
      id: "opp-1",
      organization_id: ORG,
      funnel: "post_venta",
      contact_id: "contact-1",
      stage_id: STAGE_ENTREGADO,
      cancelled_at: null,
      resolved_at: null,
      delivery_message_sent_at: HACE_7_DIAS,
      followup_message_sent_at: null,
      last_modified_at: "2026-08-14T12:00:00.000Z",
      ...overrides,
    },
  ]);
}

const run = () =>
  withTenantContext(
    ORG,
    () =>
      sendPostventaFollowup({
        organizationId: ORG,
        opportunityId: "opp-1",
        nowIso: NOW,
      }),
    { source: "worker" },
  );

const saved = () => fake.getTable("opportunities")[0] as Record<string, unknown>;
const auditTypes = (): string[] =>
  fake.getTable("audit_log").map((a) => (a as { event_type: string }).event_type);

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  mock(pushPostventaStage).mockResolvedValue({
    ok: true,
    moved: true,
    created: false,
    whaapyContactId: "wc-1",
  });
  mock(resolvePostventaStages).mockResolvedValue({
    problematicStage: { id: STAGE_PROBLEMA },
    followupStage: { id: STAGE_SEGUIMIENTO },
    terminalStageIds: new Set(),
  });
});

describe("sendPostventaFollowup — camino feliz", () => {
  it("a los 7 días: empuja a Post-venta, sella y mueve la etapa", async () => {
    seedOpp();

    const r = await run();

    expect(r).toEqual({ ok: true, sent: true });
    expect(pushPostventaStage).toHaveBeenCalledWith({
      organizationId: ORG,
      opportunityId: "opp-1",
      target: "seguimiento",
    });
    expect(saved().followup_message_sent_at).toBe(NOW);
    expect(moveOpportunityStage).toHaveBeenCalledWith(
      expect.objectContaining({ opportunityId: "opp-1", toStageId: STAGE_SEGUIMIENTO }),
    );
    expect(auditTypes()).toContain("postventa_followup_message_sent");
  });

  it("si ya está en Seguimiento, manda el mensaje pero no re-mueve", async () => {
    seedOpp({ stage_id: STAGE_SEGUIMIENTO });

    const r = await run();

    expect(r).toEqual({ ok: true, sent: true });
    expect(moveOpportunityStage).not.toHaveBeenCalled();
  });
});

describe("sendPostventaFollowup — no duplicar", () => {
  it("ya enviado: NO vuelve a mandar aunque siga cumpliendo los 7 días", async () => {
    seedOpp({ followup_message_sent_at: "2026-08-20T00:00:00.000Z" });

    const r = await run();

    expect(r).toEqual({ ok: true, sent: false, reason: "already_sent" });
    expect(pushPostventaStage).not.toHaveBeenCalled();
  });

  it("el sello se escribe ANTES de mover la etapa", async () => {
    seedOpp();
    let selladoAlMover: unknown = "no-se-movio";
    mock(moveOpportunityStage).mockImplementation(async () => {
      selladoAlMover = saved().followup_message_sent_at;
      return { ok: true };
    });

    await run();

    // Si el move fallara y reintentáramos, el sello ya impide un 2º envío.
    expect(selladoAlMover).toBe(NOW);
  });

  it("si el push a Whaapy falla, NO sella (el cliente no recibió nada)", async () => {
    seedOpp();
    mock(pushPostventaStage).mockResolvedValue({ ok: false, skipped: "missing_phone" });

    const r = await run();

    expect(r).toEqual({ ok: false, reason: "push_failed" });
    expect(saved().followup_message_sent_at).toBeNull();
    expect(moveOpportunityStage).not.toHaveBeenCalled();
  });
});

describe("sendPostventaFollowup — a quién NO mandárselo", () => {
  it("oportunidad cancelada", async () => {
    seedOpp({ cancelled_at: "2026-08-16T00:00:00.000Z" });
    const r = await run();
    expect(r).toEqual({ ok: true, sent: false, reason: "cancelled" });
    expect(pushPostventaStage).not.toHaveBeenCalled();
  });

  it("caso ya resuelto", async () => {
    seedOpp({ resolved_at: "2026-08-16T00:00:00.000Z" });
    const r = await run();
    expect(r).toEqual({ ok: true, sent: false, reason: "resolved" });
    expect(pushPostventaStage).not.toHaveBeenCalled();
  });

  it("está en Caso problemático HOY, aunque su entrega fuera normal", async () => {
    seedOpp({ stage_id: STAGE_PROBLEMA });

    const r = await run();

    expect(r).toEqual({ ok: true, sent: false, reason: "problem_case" });
    expect(pushPostventaStage).not.toHaveBeenCalled();
    expect(auditTypes()).toContain("postventa_followup_skipped");
  });
});

describe("sendPostventaFollowup — el reloj", () => {
  it("todavía no cumple los 7 días", async () => {
    seedOpp({ delivery_message_sent_at: HACE_3_DIAS });
    const r = await run();
    expect(r).toEqual({ ok: true, sent: false, reason: "not_due_yet" });
    expect(pushPostventaStage).not.toHaveBeenCalled();
  });

  it("cuenta desde el ENVÍO del mensaje 1: sin ese sello no aplica", async () => {
    seedOpp({ delivery_message_sent_at: null });
    const r = await run();
    expect(r).toEqual({ ok: true, sent: false, reason: "delivery_message_not_sent" });
    expect(pushPostventaStage).not.toHaveBeenCalled();
  });

  it("exactamente a los 7 días ya cuenta como cumplido", async () => {
    seedOpp({ delivery_message_sent_at: HACE_7_DIAS });
    const r = await run();
    expect(r).toEqual({ ok: true, sent: true });
  });
});
