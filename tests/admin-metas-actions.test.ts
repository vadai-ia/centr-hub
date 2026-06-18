import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/tenant/context", () => ({
  withTenantContext: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/auth/admin-guard", () => ({ resolveAdminContext: vi.fn() }));
vi.mock("@/lib/db/metas", () => ({
  listGoals: vi.fn(),
  getGoalFor: vi.fn(),
  createGoal: vi.fn(),
  updateGoal: vi.fn(),
  deleteGoal: vi.fn(),
  listGoalResults: vi.fn(),
}));
vi.mock("@/lib/db/organizations", () => ({
  getOrganizationById: vi.fn(),
  updateOrganization: vi.fn(),
}));
vi.mock("@/lib/db/users", () => ({ listRealVendorsForMapping: vi.fn() }));
vi.mock("@/lib/db/operational", () => ({ recordAuditEvent: vi.fn() }));

import {
  deleteGoalAction,
  saveThresholdsAction,
  upsertGoalAction,
} from "@/lib/actions/admin-metas";
import { resolveAdminContext } from "@/lib/auth/admin-guard";
import {
  createGoal,
  deleteGoal,
  getGoalFor,
  listGoals,
  updateGoal,
} from "@/lib/db/metas";
import { getOrganizationById, updateOrganization } from "@/lib/db/organizations";
import { listRealVendorsForMapping } from "@/lib/db/users";
import { recordAuditEvent } from "@/lib/db/operational";

const ORG = "org-1";
const USER = "user-admin";
// UUIDs RFC 4122 válidos (Zod v4 valida versión + variante).
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UNKNOWN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GOAL_ID = "11111111-1111-4111-8111-111111111111";

const mAdmin = vi.mocked(resolveAdminContext);
const mListGoals = vi.mocked(listGoals);
const mGetGoalFor = vi.mocked(getGoalFor);
const mCreate = vi.mocked(createGoal);
const mUpdate = vi.mocked(updateGoal);
const mDelete = vi.mocked(deleteGoal);
const mVendors = vi.mocked(listRealVendorsForMapping);
const mGetOrg = vi.mocked(getOrganizationById);
const mUpdateOrg = vi.mocked(updateOrganization);
const mAudit = vi.mocked(recordAuditEvent);

beforeEach(() => {
  vi.clearAllMocks();
  mAdmin.mockResolvedValue({ ok: true, ctx: { orgId: ORG, userId: USER } });
  mListGoals.mockResolvedValue([]);
  mVendors.mockResolvedValue([{ id: A, profile: { full_name: "Gina" } }] as never);
});

describe("gating admin", () => {
  it("rechaza no-admin sin tocar la BD", async () => {
    mAdmin.mockResolvedValue({ ok: false, message: "No tienes permisos de administrador." });
    const res = await upsertGoalAction({
      advisorMembershipId: null,
      metric: "amount",
      targetValue: 1000,
      isActive: true,
    });
    expect(res.ok).toBe(false);
    expect(mCreate).not.toHaveBeenCalled();
  });
});

describe("upsertGoalAction", () => {
  it("crea una meta nueva y redondea conteos", async () => {
    mGetGoalFor.mockResolvedValue(null);
    const res = await upsertGoalAction({
      advisorMembershipId: A,
      metric: "quotes",
      targetValue: "20.4", // string + decimal
      isActive: true,
    });
    expect(res.ok).toBe(true);
    expect(mCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        advisor_membership_id: A,
        metric: "quotes",
        target_value: "20", // redondeado
        is_active: true,
        created_by_user_id: USER,
      }),
    );
    expect(mUpdate).not.toHaveBeenCalled();
    expect(mAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "goal_upserted" }),
    );
  });

  it("actualiza la meta existente (mismo sujeto+métrica)", async () => {
    mGetGoalFor.mockResolvedValue({ id: "g-1" } as never);
    const res = await upsertGoalAction({
      advisorMembershipId: null, // equipo
      metric: "amount",
      targetValue: 80000,
      isActive: false,
    });
    expect(res.ok).toBe(true);
    expect(mUpdate).toHaveBeenCalledWith("g-1", {
      target_value: "80000",
      is_active: false,
    });
    expect(mCreate).not.toHaveBeenCalled();
  });

  it("rechaza meta para un membership que no es vendedor real", async () => {
    const res = await upsertGoalAction({
      advisorMembershipId: UNKNOWN,
      metric: "won",
      targetValue: 10,
      isActive: true,
    });
    expect(res.ok).toBe(false);
    expect(mCreate).not.toHaveBeenCalled();
  });

  it("rechaza objetivo negativo (Zod)", async () => {
    const res = await upsertGoalAction({
      advisorMembershipId: null,
      metric: "amount",
      targetValue: -5,
      isActive: true,
    });
    expect(res.ok).toBe(false);
  });
});

describe("saveThresholdsAction", () => {
  it("sanea umbrales invertidos y los fusiona en config.metas", async () => {
    mGetOrg.mockResolvedValue({ config: { pipeline: { hide_closed_after_days: 7 } } } as never);
    const res = await saveThresholdsAction({ greenPct: 70, yellowPct: 95 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.thresholds).toEqual({ greenPct: 70, yellowPct: 70 });
    // Conserva el bloque pipeline y agrega metas con los valores saneados.
    expect(mUpdateOrg).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        config: expect.objectContaining({
          pipeline: { hide_closed_after_days: 7 },
          metas: { green_pct: 70, yellow_pct: 70 },
        }),
      }),
    );
    expect(mAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "goal_thresholds_changed" }),
    );
  });

  it("rechaza umbrales fuera de rango", async () => {
    const res = await saveThresholdsAction({ greenPct: 150, yellowPct: 50 });
    expect(res.ok).toBe(false);
    expect(mUpdateOrg).not.toHaveBeenCalled();
  });
});

describe("deleteGoalAction", () => {
  it("borra y audita", async () => {
    const res = await deleteGoalAction({ id: GOAL_ID });
    expect(res.ok).toBe(true);
    expect(mDelete).toHaveBeenCalledWith(GOAL_ID);
    expect(mAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "goal_deleted" }));
  });
});
