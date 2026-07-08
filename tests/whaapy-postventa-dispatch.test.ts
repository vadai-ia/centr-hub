import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FASE 1 — dispatch de los PUSH al Whaapy de Post-venta (hooks).
 * Verifica: kill switch OFF no encola; ON encola con el target correcto por
 * vía (move Entregado/Caso Problemático, reopen, resolve); y que el
 * clasificador de move ignora Venta y etapas no relevantes.
 */

const sendMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/inngest/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inngest/client")>();
  return { ...actual, getInngestClient: () => ({ send: sendMock }) };
});

// El clasificador de move resuelve las etapas del motor Post-venta.
vi.mock("@/lib/services/postventa-transition", () => ({
  resolvePostventaEngineStages: vi.fn().mockResolvedValue({
    zoneByPosition: { 4: { id: "eng-entregado" } },
    problematicStage: { id: "eng-prob" },
  }),
}));

import {
  dispatchPostventaPushForMove,
  dispatchPostventaPushForReopen,
  dispatchPostventaPushForResolve,
} from "@/lib/whaapy-postventa/dispatch";
import type { PipelineStageRow } from "@/lib/types/database";

const ORG = "org-1";
const OPP = "opp-1";

function stage(id: string, funnel: "venta" | "post_venta"): PipelineStageRow {
  return { id, funnel } as PipelineStageRow;
}

function lastSendTarget(): string | undefined {
  const call = sendMock.mock.calls.at(-1)?.[0] as
    | { data?: { target?: string } }
    | undefined;
  return call?.data?.target;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.POSTVENTA_WHAAPY_SYNC_ENABLED = "true";
});
afterEach(() => {
  delete process.env.POSTVENTA_WHAAPY_SYNC_ENABLED;
});

describe("dispatch — kill switch", () => {
  it("OFF: reopen no encola", async () => {
    delete process.env.POSTVENTA_WHAAPY_SYNC_ENABLED;
    await dispatchPostventaPushForReopen({ organizationId: ORG, opportunityId: OPP });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("OFF: move no encola (ni resuelve etapas)", async () => {
    delete process.env.POSTVENTA_WHAAPY_SYNC_ENABLED;
    await dispatchPostventaPushForMove({
      organizationId: ORG,
      opportunityId: OPP,
      targetStage: stage("eng-entregado", "post_venta"),
    });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("dispatch — targets por vía (kill switch ON)", () => {
  it("reopen → casoProblematico", async () => {
    await dispatchPostventaPushForReopen({ organizationId: ORG, opportunityId: OPP });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(lastSendTarget()).toBe("casoProblematico");
  });

  it("resolve → casoResuelto", async () => {
    await dispatchPostventaPushForResolve({ organizationId: ORG, opportunityId: OPP });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(lastSendTarget()).toBe("casoResuelto");
  });

  it("move a Entregado (post_venta) → entregado", async () => {
    await dispatchPostventaPushForMove({
      organizationId: ORG,
      opportunityId: OPP,
      targetStage: stage("eng-entregado", "post_venta"),
    });
    expect(lastSendTarget()).toBe("entregado");
  });

  it("move a Caso Problemático (post_venta) → casoProblematico", async () => {
    await dispatchPostventaPushForMove({
      organizationId: ORG,
      opportunityId: OPP,
      targetStage: stage("eng-prob", "post_venta"),
    });
    expect(lastSendTarget()).toBe("casoProblematico");
  });

  it("move en funnel Venta → NO encola", async () => {
    await dispatchPostventaPushForMove({
      organizationId: ORG,
      opportunityId: OPP,
      targetStage: stage("cualquier-venta", "venta"),
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("move a etapa post_venta irrelevante → NO encola", async () => {
    await dispatchPostventaPushForMove({
      organizationId: ORG,
      opportunityId: OPP,
      targetStage: stage("eng-pago-confirmado", "post_venta"),
    });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
