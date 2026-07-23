import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/tenant/context", () => ({
  withTenantContext: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/capabilities", () => ({ hasTab: vi.fn(() => true) }));
vi.mock("@/lib/db/pipeline", () => ({
  countOpportunitiesForStage: vi.fn(),
  countStageHistoryReferences: vi.fn(),
  createStage: vi.fn(),
  deleteStage: vi.fn(),
  getStageById: vi.fn(),
  listPipelineStages: vi.fn(),
  reorderStages: vi.fn(),
  updateStage: vi.fn(),
}));
vi.mock("@/lib/db/automation", () => ({ listActiveRuleStageNames: vi.fn() }));
vi.mock("@/lib/db/operational", () => ({ recordAuditEvent: vi.fn() }));

import { deleteStageAction } from "@/lib/actions/admin-stages";
import { getSession } from "@/lib/auth/session";
import {
  countOpportunitiesForStage,
  countStageHistoryReferences,
  deleteStage,
  getStageById,
  listPipelineStages,
  updateStage,
} from "@/lib/db/pipeline";
import { listActiveRuleStageNames } from "@/lib/db/automation";
import type { PipelineStageRow } from "@/lib/types/database";

const ORG = "org-1";
const STAGE_ID = "11111111-1111-4111-8111-111111111111";

const mSession = vi.mocked(getSession);
const mGetStage = vi.mocked(getStageById);
const mList = vi.mocked(listPipelineStages);
const mRules = vi.mocked(listActiveRuleStageNames);
const mOpps = vi.mocked(countOpportunitiesForStage);
const mHistory = vi.mocked(countStageHistoryReferences);
const mDelete = vi.mocked(deleteStage);
const mUpdate = vi.mocked(updateStage);

function stage(flags: Partial<PipelineStageRow> = {}): PipelineStageRow {
  return {
    id: STAGE_ID,
    organization_id: ORG,
    funnel: "venta",
    name: "Contactado asesor", // intermedia: sin flags ni nombre canónico
    position: 2,
    color: "#94A3B8",
    default_probability: null,
    is_initial: false,
    is_won: false,
    is_lost: false,
    requires_loss_reason: false,
    is_active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...flags,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mSession.mockResolvedValue({
    status: "ok",
    data: {
      userId: "user-admin",
      activeOrg: { id: ORG },
      activeRole: { key: "admin", allowedTabs: ["admin-etapas"], dataScope: "all" },
    },
  } as never);
  const s = stage();
  mGetStage.mockResolvedValue(s);
  mList.mockResolvedValue([s]);
  mRules.mockResolvedValue([]);
});

describe("deleteStageAction — decisión borrar / desactivar / bloquear", () => {
  it("bloquea si hay oportunidades dentro (mover primero)", async () => {
    mOpps.mockResolvedValue(3);
    const res = await deleteStageAction({ id: STAGE_ID });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/3 oportunidad/);
    expect(mDelete).not.toHaveBeenCalled();
    expect(mUpdate).not.toHaveBeenCalled();
  });

  it("DESACTIVA (no borra) si la etapa tiene historial inmutable", async () => {
    mOpps.mockResolvedValue(0);
    mHistory.mockResolvedValue(5);
    const res = await deleteStageAction({ id: STAGE_ID });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outcome).toBe("deactivated");
    expect(mUpdate).toHaveBeenCalledWith(STAGE_ID, { is_active: false });
    expect(mDelete).not.toHaveBeenCalled();
  });

  it("borra en duro si no hay opps, ni historial, ni automatización", async () => {
    mOpps.mockResolvedValue(0);
    mHistory.mockResolvedValue(0);
    mRules.mockResolvedValue([]);
    const res = await deleteStageAction({ id: STAGE_ID });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outcome).toBe("deleted");
    expect(mDelete).toHaveBeenCalledWith(STAGE_ID);
  });

  it("exige la palabra 'eliminar' para borrar una etapa ligada a automatizaciones", async () => {
    mOpps.mockResolvedValue(0);
    mHistory.mockResolvedValue(0);
    mRules.mockResolvedValue([{ stageName: "Contactado asesor", ruleLabel: "R" }]);
    const res = await deleteStageAction({ id: STAGE_ID }); // sin confirm
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/eliminar/i);
    expect(mDelete).not.toHaveBeenCalled();
  });

  it("borra la etapa ligada cuando se teclea 'eliminar'", async () => {
    mOpps.mockResolvedValue(0);
    mHistory.mockResolvedValue(0);
    mRules.mockResolvedValue([{ stageName: "Contactado asesor", ruleLabel: "R" }]);
    const res = await deleteStageAction({ id: STAGE_ID, confirm: "Eliminar" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outcome).toBe("deleted");
    expect(mDelete).toHaveBeenCalledWith(STAGE_ID);
  });

  it("degrada a mensaje accionable si el borrado en duro lanza FK inesperado", async () => {
    mOpps.mockResolvedValue(0);
    mHistory.mockResolvedValue(0);
    mRules.mockResolvedValue([]);
    mDelete.mockRejectedValueOnce(new Error("FK violation"));
    const res = await deleteStageAction({ id: STAGE_ID });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/desactivar/i);
  });
});
