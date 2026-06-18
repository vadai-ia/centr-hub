import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/tenant/context", () => ({
  withTenantContext: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/db/users", () => ({ getMembership: vi.fn() }));
vi.mock("@/lib/services/goal-progress", () => ({
  loadAdminGoalProgress: vi.fn(),
  loadVendorGoalProgress: vi.fn(),
}));

import { loadDashboardGoals, loadMyGoalProgress } from "@/lib/actions/dashboard-goals";
import { getSession } from "@/lib/auth/session";
import { getMembership } from "@/lib/db/users";
import {
  loadAdminGoalProgress,
  loadVendorGoalProgress,
} from "@/lib/services/goal-progress";

const ORG = "org-1";
const USER = "user-1";
const MEMBERSHIP = "mem-1";

const mSession = vi.mocked(getSession);
const mMembership = vi.mocked(getMembership);
const mAdmin = vi.mocked(loadAdminGoalProgress);
const mVendor = vi.mocked(loadVendorGoalProgress);

function sessionWithRole(role: "admin" | "vendedor") {
  mSession.mockResolvedValue({
    status: "ok",
    data: { activeOrg: { id: ORG, role, name: "Centr" }, userId: USER },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mAdmin.mockResolvedValue({ thresholds: { greenPct: 85, yellowPct: 50 }, monthKey: "2026-06", team: [], byVendor: [] } as never);
  mVendor.mockResolvedValue({ thresholds: { greenPct: 85, yellowPct: 50 }, monthKey: "2026-06", goals: [] } as never);
  mMembership.mockResolvedValue({ id: MEMBERSHIP } as never);
});

describe("loadDashboardGoals (routing por rol)", () => {
  it("admin → usa la agregación de equipo + vendedores", async () => {
    sessionWithRole("admin");
    const res = await loadDashboardGoals();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.view.isAdmin).toBe(true);
    expect(mAdmin).toHaveBeenCalledWith(ORG);
    expect(mVendor).not.toHaveBeenCalled();
  });

  it("vendedor → SOLO su avance (membership.id), nunca la ruta admin", async () => {
    sessionWithRole("vendedor");
    const res = await loadDashboardGoals();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.view.isAdmin).toBe(false);
    expect(mVendor).toHaveBeenCalledWith(ORG, MEMBERSHIP);
    expect(mAdmin).not.toHaveBeenCalled();
  });

  it("sin sesión → error, sin tocar el servicio", async () => {
    mSession.mockResolvedValue({ status: "expired" } as never);
    const res = await loadDashboardGoals();
    expect(res.ok).toBe(false);
    expect(mAdmin).not.toHaveBeenCalled();
    expect(mVendor).not.toHaveBeenCalled();
  });
});

describe("loadMyGoalProgress (widget Mi Día)", () => {
  it("vendedor → su propio avance (membership.id)", async () => {
    sessionWithRole("vendedor");
    const res = await loadMyGoalProgress();
    expect(res.ok).toBe(true);
    expect(mVendor).toHaveBeenCalledWith(ORG, MEMBERSHIP);
    expect(mAdmin).not.toHaveBeenCalled();
  });

  it("admin tambien ve SU propia meta (vista-vendedor), nunca la agregación admin", async () => {
    sessionWithRole("admin");
    const res = await loadMyGoalProgress();
    expect(res.ok).toBe(true);
    expect(mVendor).toHaveBeenCalledWith(ORG, MEMBERSHIP);
    expect(mAdmin).not.toHaveBeenCalled();
  });

  it("sin sesión → error", async () => {
    mSession.mockResolvedValue({ status: "expired" } as never);
    const res = await loadMyGoalProgress();
    expect(res.ok).toBe(false);
    expect(mVendor).not.toHaveBeenCalled();
  });
});
