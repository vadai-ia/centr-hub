import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/metas", () => ({
  listGoals: vi.fn(),
  listGoalResultsForMonth: vi.fn(),
  insertGoalResults: vi.fn(),
}));
vi.mock("@/lib/services/dashboard-metrics", () => ({ computeGoalAchievement: vi.fn() }));

import { snapshotMonthlyGoals } from "@/lib/services/goal-snapshot";
import { listGoals, listGoalResultsForMonth, insertGoalResults } from "@/lib/db/metas";
import { computeGoalAchievement } from "@/lib/services/dashboard-metrics";
import {
  previousMonthDateKey,
  resolvePreviousMonthPeriod,
} from "@/lib/time/period";
import type { GoalRow } from "@/lib/types/database";

const A = "mem-A";
const PERIOD = {
  startUtc: "2026-05-01T06:00:00.000Z",
  endUtc: "2026-06-01T05:59:59.999Z",
  startLabel: "2026-05-01",
  endLabel: "2026-05-31",
};

const mListGoals = vi.mocked(listGoals);
const mForMonth = vi.mocked(listGoalResultsForMonth);
const mInsert = vi.mocked(insertGoalResults);
const mAch = vi.mocked(computeGoalAchievement);

function goal(p: Partial<GoalRow> & Pick<GoalRow, "id" | "metric" | "target_value">): GoalRow {
  return {
    organization_id: "org",
    advisor_membership_id: null,
    is_active: true,
    created_by_user_id: null,
    created_at: "x",
    updated_at: "x",
    ...p,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mForMonth.mockResolvedValue([]);
});

describe("snapshotMonthlyGoals", () => {
  it("idempotente: si ya hay snapshots del mes, no escribe", async () => {
    mForMonth.mockResolvedValue([{ id: "r1" }] as never);
    const res = await snapshotMonthlyGoals({ period: PERIOD, periodMonth: "2026-05-01" });
    expect(res).toMatchObject({ written: 0, skipped: true });
    expect(mInsert).not.toHaveBeenCalled();
    expect(mAch).not.toHaveBeenCalled();
  });

  it("sin metas activas: no escribe", async () => {
    mListGoals.mockResolvedValue([]);
    const res = await snapshotMonthlyGoals({ period: PERIOD, periodMonth: "2026-05-01" });
    expect(res).toMatchObject({ written: 0, skipped: false });
    expect(mInsert).not.toHaveBeenCalled();
  });

  it("congela target/logrado/pct por meta (equipo→all, vendedor→su scope)", async () => {
    mListGoals.mockResolvedValue([
      goal({ id: "g-team", metric: "amount", target_value: "100000", advisor_membership_id: null }),
      goal({ id: "g-A", metric: "quotes", target_value: "20", advisor_membership_id: A }),
    ]);
    mAch.mockImplementation(async (_p, scopes) =>
      scopes.map((s) => (s === "all" ? { quotes: 0, won: 0, amount: 118000 } : { quotes: 17, won: 0, amount: 0 })),
    );

    const res = await snapshotMonthlyGoals({ period: PERIOD, periodMonth: "2026-05-01" });
    expect(res).toMatchObject({ written: 2, skipped: false });

    const rows = mInsert.mock.calls[0][0];
    const team = rows.find((r) => r.goal_id === "g-team")!;
    expect(team).toMatchObject({
      advisor_membership_id: null,
      metric: "amount",
      period_month: "2026-05-01",
      target_value: "100000",
      achieved_value: "118000",
      pct: "118.00",
    });
    const gA = rows.find((r) => r.goal_id === "g-A")!;
    expect(gA).toMatchObject({
      advisor_membership_id: A,
      metric: "quotes",
      achieved_value: "17",
      pct: "85.00", // 17/20
    });
  });
});

describe("resolvePreviousMonthPeriod / previousMonthDateKey (CDMX)", () => {
  afterEach(() => vi.useRealTimers());

  it("el día 1 snapshotea el mes anterior (jul → junio)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T07:30:00.000Z")); // 01:30 MX, 1-jul
    expect(previousMonthDateKey()).toBe("2026-06-01");
    const p = resolvePreviousMonthPeriod();
    expect(p.startUtc).toBe("2026-06-01T06:00:00.000Z");
    expect(p.endUtc).toBe("2026-07-01T05:59:59.999Z");
  });

  it("cruza el año (1-ene → diciembre previo)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T07:30:00.000Z")); // 01:30 MX, 1-ene-2026
    expect(previousMonthDateKey()).toBe("2025-12-01");
  });
});
