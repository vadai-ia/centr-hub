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
 *   4. **La vía manual salta el tiempo, no la elegibilidad.** Mover la
 *      tarjeta a "Seguimiento post-entrega" ES la decisión de mandarla, así
 *      que no exige mensaje 1 previo ni los 7 días — pero a un caso
 *      cancelado, resuelto o problemático sigue sin escribírsele.
 *
 * El envío es DIRECTO (`sendPostventaTemplate`), no vía Automation de
 * Whaapy: su trigger es ENTRAR a la etapa, así que con quien ya está en
 * ella no dispara y el mensaje se perdía en silencio con el sello puesto.
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdminClient: () => fake }));

vi.mock("@/lib/whaapy-postventa/send-template", () => ({
  sendPostventaTemplate: vi.fn(),
}));
vi.mock("@/lib/services/dashboard-stages", () => ({
  resolvePostventaStages: vi.fn(),
}));
vi.mock("@/lib/services/pipeline-move", () => ({
  moveOpportunityStage: vi.fn().mockResolvedValue({ ok: true }),
}));

import { withTenantContext } from "@/lib/tenant/context";
import { sendPostventaFollowup } from "@/lib/services/postventa-followup";
import { sendPostventaTemplate } from "@/lib/whaapy-postventa/send-template";
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

function seedContact(overrides: Record<string, unknown> = {}) {
  fake.setTable("contacts", [
    {
      id: "contact-1",
      organization_id: ORG,
      full_name: "Patricia Guerrero",
      phone: "+525548995599",
      ...overrides,
    },
  ]);
}

function seedOpp(overrides: Record<string, unknown> = {}) {
  seedContact();
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
  mock(sendPostventaTemplate).mockResolvedValue(undefined);
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
    expect(sendPostventaTemplate).toHaveBeenCalledWith(ORG, {
      to: "+525548995599",
      templateName: "7_dias",
      parameters: ["Patricia"],
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
    expect(sendPostventaTemplate).not.toHaveBeenCalled();
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
    seedContact({ phone: null });

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
    expect(sendPostventaTemplate).not.toHaveBeenCalled();
  });

  it("caso ya resuelto", async () => {
    seedOpp({ resolved_at: "2026-08-16T00:00:00.000Z" });
    const r = await run();
    expect(r).toEqual({ ok: true, sent: false, reason: "resolved" });
    expect(sendPostventaTemplate).not.toHaveBeenCalled();
  });

  it("está en Caso problemático HOY, aunque su entrega fuera normal", async () => {
    seedOpp({ stage_id: STAGE_PROBLEMA });

    const r = await run();

    expect(r).toEqual({ ok: true, sent: false, reason: "problem_case" });
    expect(sendPostventaTemplate).not.toHaveBeenCalled();
    expect(auditTypes()).toContain("postventa_followup_skipped");
  });
});

describe("sendPostventaFollowup — el reloj", () => {
  it("todavía no cumple los 7 días", async () => {
    seedOpp({ delivery_message_sent_at: HACE_3_DIAS });
    const r = await run();
    expect(r).toEqual({ ok: true, sent: false, reason: "not_due_yet" });
    expect(sendPostventaTemplate).not.toHaveBeenCalled();
  });

  it("cuenta desde el ENVÍO del mensaje 1: sin ese sello no aplica", async () => {
    seedOpp({ delivery_message_sent_at: null });
    const r = await run();
    expect(r).toEqual({ ok: true, sent: false, reason: "delivery_message_not_sent" });
    expect(sendPostventaTemplate).not.toHaveBeenCalled();
  });

  it("exactamente a los 7 días ya cuenta como cumplido", async () => {
    seedOpp({ delivery_message_sent_at: HACE_7_DIAS });
    const r = await run();
    expect(r).toEqual({ ok: true, sent: true });
  });
});

describe("vía manual — mover la tarjeta a Seguimiento post-entrega", () => {
  const manual = () =>
    withTenantContext(
      ORG,
      () =>
        sendPostventaFollowup({
          organizationId: ORG,
          opportunityId: "opp-1",
          nowIso: NOW,
          trigger: "manual_move",
        }),
      { source: "worker" },
    );

  it("manda aunque NUNCA haya salido el mensaje de entrega", async () => {
    // Es el caso real: pedidos entregados antes de que existieran los
    // mensajes. Por la vía automática no la recibirían jamás.
    seedOpp({ delivery_message_sent_at: null, stage_id: STAGE_SEGUIMIENTO });

    const r = await manual();

    expect(r).toEqual({ ok: true, sent: true });
    expect(sendPostventaTemplate).toHaveBeenCalledTimes(1);
    expect(saved().followup_message_sent_at).toBe(NOW);
  });

  it("manda aunque no hayan pasado los 7 días", async () => {
    seedOpp({ delivery_message_sent_at: HACE_3_DIAS, stage_id: STAGE_SEGUIMIENTO });

    expect(await manual()).toEqual({ ok: true, sent: true });
  });

  it("NO manda dos veces: el sello manda sobre el disparador", async () => {
    seedOpp({ followup_message_sent_at: "2026-08-20T10:00:00.000Z" });

    const r = await manual();

    expect(r).toEqual({ ok: true, sent: false, reason: "already_sent" });
    expect(sendPostventaTemplate).not.toHaveBeenCalled();
  });

  it("sigue sin escribirle a un caso problemático, aunque lo arrastren", async () => {
    seedOpp({ stage_id: STAGE_PROBLEMA, delivery_message_sent_at: null });

    const r = await manual();

    expect(r).toEqual({ ok: true, sent: false, reason: "problem_case" });
    expect(sendPostventaTemplate).not.toHaveBeenCalled();
  });

  it("sigue sin escribirle a una cancelada", async () => {
    seedOpp({ cancelled_at: "2026-08-19T10:00:00.000Z", delivery_message_sent_at: null });

    const r = await manual();

    expect(r).toEqual({ ok: true, sent: false, reason: "cancelled" });
    expect(sendPostventaTemplate).not.toHaveBeenCalled();
  });
});
