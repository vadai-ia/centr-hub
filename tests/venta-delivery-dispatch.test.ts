import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MENSAJE 1 — confirmación de entrega desde el número de VENTAS.
 *
 * Invariante central: los dos mensajes de Post-venta salen de instancias
 * DISTINTAS de Whaapy y por lo tanto tienen kill switches INDEPENDIENTES.
 * El de entrega (Venta) y el de casos (Post-venta) no se pueden apagar ni
 * encender el uno al otro — antes el hook salía temprano con el switch de
 * Post-venta y se habría llevado el de Venta por delante.
 */

const sendMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/inngest/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inngest/client")>();
  return { ...actual, getInngestClient: () => ({ send: sendMock }) };
});

vi.mock("@/lib/services/postventa-transition", () => ({
  resolvePostventaEngineStages: vi.fn().mockResolvedValue({
    zoneByPosition: { 4: { id: "eng-entregado" } },
    problematicStage: { id: "eng-prob" },
  }),
}));

import { dispatchPostventaPushForMove } from "@/lib/whaapy-postventa/dispatch";
import { VENTA_DELIVERY_MESSAGE_EVENT } from "@/lib/inngest/client";
import type { PipelineStageRow } from "@/lib/types/database";

const ORG = "org-1";
const OPP = "opp-1";
const stage = (id: string, funnel: "venta" | "post_venta") =>
  ({ id, funnel }) as PipelineStageRow;

const moveTo = (id: string) =>
  dispatchPostventaPushForMove({
    organizationId: ORG,
    opportunityId: OPP,
    targetStage: stage(id, "post_venta"),
  });

/** Nombres de evento enviados, en orden. */
const sentEvents = (): string[] =>
  sendMock.mock.calls.map((c) => (c[0] as { name: string }).name);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.POSTVENTA_WHAAPY_SYNC_ENABLED;
  delete process.env.VENTA_DELIVERY_MESSAGE_ENABLED;
});
afterEach(() => {
  delete process.env.POSTVENTA_WHAAPY_SYNC_ENABLED;
  delete process.env.VENTA_DELIVERY_MESSAGE_ENABLED;
});

describe("mensaje de entrega (Venta) — kill switch propio", () => {
  it("ambos OFF: no encola nada", async () => {
    await moveTo("eng-entregado");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("solo VENTA ON: encola el mensaje de entrega y NADA de Post-venta", async () => {
    process.env.VENTA_DELIVERY_MESSAGE_ENABLED = "true";
    await moveTo("eng-entregado");
    expect(sentEvents()).toEqual([VENTA_DELIVERY_MESSAGE_EVENT]);
  });

  it("solo POST-VENTA ON: NO encola el mensaje de entrega", async () => {
    process.env.POSTVENTA_WHAAPY_SYNC_ENABLED = "true";
    await moveTo("eng-entregado");
    expect(sentEvents()).not.toContain(VENTA_DELIVERY_MESSAGE_EVENT);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("ambos ON: encola los dos, cada uno a su instancia", async () => {
    process.env.POSTVENTA_WHAAPY_SYNC_ENABLED = "true";
    process.env.VENTA_DELIVERY_MESSAGE_ENABLED = "true";
    await moveTo("eng-entregado");
    expect(sentEvents()).toContain(VENTA_DELIVERY_MESSAGE_EVENT);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});

describe("mensaje de entrega (Venta) — solo en la etapa Entregado", () => {
  beforeEach(() => {
    process.env.VENTA_DELIVERY_MESSAGE_ENABLED = "true";
  });

  it("Caso Problemático NO dispara el mensaje de entrega", async () => {
    await moveTo("eng-prob");
    expect(sentEvents()).not.toContain(VENTA_DELIVERY_MESSAGE_EVENT);
  });

  it("una etapa cualquiera de Post-venta no dispara nada", async () => {
    await moveTo("otra-etapa");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("el funnel de Venta nunca dispara este hook", async () => {
    await dispatchPostventaPushForMove({
      organizationId: ORG,
      opportunityId: OPP,
      targetStage: stage("eng-entregado", "venta"),
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("el envelope lleva org, opp y el origen del disparo", async () => {
    await moveTo("eng-entregado");
    const call = sendMock.mock.calls.find(
      (c) => (c[0] as { name: string }).name === VENTA_DELIVERY_MESSAGE_EVENT,
    );
    expect(call?.[0]).toMatchObject({
      name: VENTA_DELIVERY_MESSAGE_EVENT,
      data: { organizationId: ORG, opportunityId: OPP, reason: "move:entregado" },
    });
  });
});
