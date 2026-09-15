import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/metas", () => ({ listGoals: vi.fn() }));
vi.mock("@/lib/db/organizations", () => ({ getOrganizationById: vi.fn() }));
vi.mock("@/lib/db/users", () => ({ listRealVendorsForMapping: vi.fn() }));
vi.mock("@/lib/services/dashboard-metrics", () => ({ computeGoalAchievement: vi.fn() }));

import {
  loadAdminGoalProgress,
  loadVendorGoalProgress,
} from "@/lib/services/goal-progress";
import { listGoals } from "@/lib/db/metas";
import { getOrganizationById } from "@/lib/db/organizations";
import { listRealVendorsForMapping } from "@/lib/db/users";
import { computeGoalAchievement } from "@/lib/services/dashboard-metrics";
import type { GoalRow } from "@/lib/types/database";

const ORG = "org-1";
const A = "mem-A";
const B = "mem-B";

const mockedListGoals = vi.mocked(listGoals);
const mockedGetOrg = vi.mocked(getOrganizationById);
const mockedVendors = vi.mocked(listRealVendorsForMapping);
const mockedAch = vi.mocked(computeGoalAchievement);

function goal(partial: Partial<GoalRow> & Pick<GoalRow, "id" | "metric" | "target_value">): GoalRow {
  const base = {
    organization_id: ORG,
    advisor_membership_id: null,
    is_active: true,
    created_by_user_id: null,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...partial,
  };
  // `subject` se deriva igual que el backfill de 0051 cuando el caso de
  // prueba no lo fija: sin vendedor = meta de equipo.
  return {
    ...base,
    subject: partial.subject ?? (base.advisor_membership_id === null ? "team" : "advisor"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Umbrales default desde config (rojo<50 · amarillo 50-84 · verde ≥85).
  mockedGetOrg.mockResolvedValue({
    config: { metas: { green_pct: 85, yellow_pct: 50 } },
  } as never);
  mockedVendors.mockResolvedValue([
    { id: A, profile: { full_name: "Gina", color: "#f00" } },
    { id: B, profile: { full_name: "Pepe", color: "#00f" } },
  ] as never);
});

describe("loadVendorGoalProgress (scoping del vendedor)", () => {
  it("devuelve SOLO las metas del vendedor — nunca equipo ni de otros", async () => {
    mockedListGoals.mockResolvedValue([
      goal({ id: "g-team", metric: "amount", target_value: "100000", advisor_membership_id: null }),
      goal({ id: "g-A", metric: "won", target_value: "20", advisor_membership_id: A }),
      goal({ id: "g-B", metric: "won", target_value: "10", advisor_membership_id: B }),
    ]);
    mockedAch.mockResolvedValue([{ quotes: 10, won: 17, amount: 9000, quotesWon: 3 }]); // scope [A]

    const res = await loadVendorGoalProgress(ORG, A);

    expect(res.goals).toHaveLength(1);
    expect(res.goals[0].goalId).toBe("g-A");
    expect(res.goals[0].achieved).toBe(17); // métrica won
    expect(res.goals[0].pct).toBe(85); // 17/20
    expect(res.goals[0].zone).toBe("green");
    expect(res.closeRate).toEqual({ quotes: 10, quotesWon: 3, pct: 30 });
    // Solo se pidió el scope del propio vendedor.
    expect(mockedAch).toHaveBeenCalledWith(expect.anything(), [
      { kind: "advisor", membershipId: A },
    ]);
  });

  it("sin meta activa: no hay barras de meta, pero su % de cierre sí se calcula", async () => {
    mockedListGoals.mockResolvedValue([
      goal({ id: "g-B", metric: "won", target_value: "10", advisor_membership_id: B }),
    ]);
    mockedAch.mockResolvedValue([{ quotes: 100, won: 0, amount: 0, quotesWon: 30 }]);
    const res = await loadVendorGoalProgress(ORG, A);
    expect(res.goals).toEqual([]);
    expect(res.closeRate).toEqual({ quotes: 100, quotesWon: 30, pct: 30 });
  });

  it("las metas viejas de cotizaciones y % de cierre ya no cuentan (se calculan solos)", async () => {
    mockedListGoals.mockResolvedValue([
      goal({ id: "g-q", metric: "quotes", target_value: "120", advisor_membership_id: A }),
      goal({ id: "g-cr", metric: "close_rate", target_value: "30", advisor_membership_id: A }),
      goal({ id: "g-amt", metric: "amount", target_value: "1000", advisor_membership_id: A }),
    ]);
    mockedAch.mockResolvedValue([{ quotes: 4, won: 1, amount: 500, quotesWon: 1 }]);
    const res = await loadVendorGoalProgress(ORG, A);
    expect(res.goals.map((g) => g.goalId)).toEqual(["g-amt"]);
  });

  it("sin membership no consulta nada", async () => {
    mockedListGoals.mockResolvedValue([]);
    const res = await loadVendorGoalProgress(ORG, "");
    expect(res.closeRate.pct).toBeNull();
    expect(mockedAch).not.toHaveBeenCalled();
  });
});

describe("loadAdminGoalProgress (equipo + por vendedor)", () => {
  it("mapea la meta de equipo al scope 'all' y cada vendedor a su scope", async () => {
    mockedListGoals.mockResolvedValue([
      goal({ id: "g-team", metric: "amount", target_value: "100000", advisor_membership_id: null }),
      goal({ id: "g-A", metric: "won", target_value: "20", advisor_membership_id: A }),
      goal({ id: "g-B", metric: "won", target_value: "10", advisor_membership_id: B }),
    ]);
    // scopes esperados en orden: [team, A, B]
    mockedAch.mockImplementation(async (_p, scopes) =>
      scopes.map((s) => {
        if (s.kind === "team") return { quotes: 0, won: 0, amount: 120000, quotesWon: 0 };
        if (s.kind === "advisor" && s.membershipId === A)
          return { quotes: 0, won: 10, amount: 0, quotesWon: 0 };
        return { quotes: 0, won: 12, amount: 0, quotesWon: 0 }; // B
      }),
    );

    const res = await loadAdminGoalProgress(ORG);

    expect(res.team).toHaveLength(1);
    expect(res.team[0].achieved).toBe(120000);
    expect(res.team[0].pct).toBe(120); // sobrecumplimiento
    expect(res.team[0].zone).toBe("gold");

    const gina = res.byVendor.find((v) => v.membershipId === A)!;
    expect(gina.name).toBe("Gina");
    expect(gina.goals[0].achieved).toBe(10); // won
    expect(gina.goals[0].pct).toBe(50);
    expect(gina.goals[0].zone).toBe("yellow");

    const pepe = res.byVendor.find((v) => v.membershipId === B)!;
    expect(pepe.goals[0].achieved).toBe(12); // won, target 10 → 120%
    expect(pepe.goals[0].zone).toBe("gold");
  });

  it("% de cierre automático: equipo y cada asesor con cotizaciones, tengan meta o no", async () => {
    mockedListGoals.mockResolvedValue([
      goal({ id: "g-A", metric: "won", target_value: "20", advisor_membership_id: A }),
    ]);
    mockedAch.mockImplementation(async (_p, scopes) =>
      scopes.map((s) => {
        if (s.kind === "team") return { quotes: 100, won: 30, amount: 0, quotesWon: 30 };
        if (s.kind === "advisor" && s.membershipId === A)
          return { quotes: 0, won: 5, amount: 0, quotesWon: 0 };
        return { quotes: 40, won: 0, amount: 0, quotesWon: 10 }; // B: sin meta, con cotizaciones
      }),
    );

    const res = await loadAdminGoalProgress(ORG);
    expect(res.team).toEqual([]);
    expect(mockedAch).toHaveBeenCalledWith(expect.anything(), [
      { kind: "team" },
      { kind: "advisor", membershipId: A },
      { kind: "advisor", membershipId: B },
    ]);
    // 100 cotizaciones y 30 pagadas = 30%.
    expect(res.teamCloseRate).toEqual({ quotes: 100, quotesWon: 30, pct: 30 });
    const pepe = res.byVendor.find((v) => v.membershipId === B)!;
    expect(pepe.goals).toEqual([]);
    expect(pepe.closeRate).toEqual({ quotes: 40, quotesWon: 10, pct: 25 });
    // Gina tiene meta aunque no cotizó: sigue en la lista, con el % sin medir.
    expect(res.byVendor.find((v) => v.membershipId === A)!.closeRate.pct).toBeNull();
  });

  it("un asesor sin meta ni cotizaciones en el mes no aparece", async () => {
    mockedListGoals.mockResolvedValue([]);
    mockedAch.mockImplementation(async (_p, scopes) =>
      scopes.map(() => ({ quotes: 0, won: 0, amount: 0, quotesWon: 0 })),
    );
    const res = await loadAdminGoalProgress(ORG);
    expect(res.byVendor).toEqual([]);
  });
});

describe("meta de venta orgánica (0051)", () => {
  it("computa su avance en un scope propio, separado del de equipo", async () => {
    mockedListGoals.mockResolvedValue([
      goal({ id: "g-team", metric: "amount", target_value: "7000000", subject: "team" }),
      goal({ id: "g-org", metric: "amount", target_value: "1000000", subject: "organic" }),
    ]);
    mockedAch.mockImplementation(async (_p, scopes) =>
      scopes.map((s) =>
        s.kind === "team"
          ? { quotes: 0, won: 0, amount: 5_000_000, quotesWon: 0 }
          : { quotes: 0, won: 0, amount: 130_000, quotesWon: 0 },
      ),
    );

    const res = await loadAdminGoalProgress(ORG);
    expect(res.team).toHaveLength(1);
    expect(res.organic).toHaveLength(1);
    // El logro orgánico NO es el del equipo: son cubetas distintas.
    expect(res.organic[0].achieved).toBe(130_000);
    expect(res.team[0].achieved).toBe(5_000_000);
    expect(res.organic[0].subject).toBe("organic");
  });

  it("un vendedor NO ve la meta orgánica (no es de nadie en particular)", async () => {
    mockedListGoals.mockResolvedValue([
      goal({ id: "g-org", metric: "amount", target_value: "1000000", subject: "organic" }),
      goal({ id: "g-A", metric: "amount", target_value: "3000000", advisor_membership_id: A, subject: "advisor" }),
    ]);
    mockedAch.mockResolvedValue([{ quotes: 0, won: 0, amount: 900_000, quotesWon: 0 }]);

    const res = await loadVendorGoalProgress(ORG, A);
    expect(res.goals).toHaveLength(1);
    expect(res.goals[0].goalId).toBe("g-A");
  });

  it("sin meta orgánica activa, no se computa su scope", async () => {
    mockedListGoals.mockResolvedValue([
      goal({ id: "g-team", metric: "amount", target_value: "7000000", subject: "team" }),
    ]);
    mockedAch.mockResolvedValue([{ quotes: 0, won: 0, amount: 1, quotesWon: 0 }]);

    const res = await loadAdminGoalProgress(ORG);
    expect(res.organic).toEqual([]);
    expect(mockedAch).toHaveBeenCalledWith(expect.anything(), [
      { kind: "team" },
      { kind: "advisor", membershipId: A },
      { kind: "advisor", membershipId: B },
    ]);
  });
});
