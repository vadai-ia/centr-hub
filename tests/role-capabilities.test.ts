import { describe, expect, it } from "vitest";
import {
  ADMIN_TAB_KEYS,
  GENERAL_TAB_KEYS,
  canAccessAdminPanel,
  canSeeAllData,
  fallbackCapabilities,
  hasTab,
  landingHref,
  type RoleCapabilities,
} from "@/lib/auth/capabilities";

function caps(partial: Partial<RoleCapabilities>): RoleCapabilities {
  return {
    key: "x",
    label: "X",
    dataScope: "own",
    allowedTabs: [],
    isSystem: false,
    ...partial,
  };
}

const ADMIN = caps({
  key: "admin",
  dataScope: "all",
  allowedTabs: [...GENERAL_TAB_KEYS, ...ADMIN_TAB_KEYS],
  isSystem: true,
});
const VENDEDOR = caps({
  key: "vendedor",
  dataScope: "own",
  allowedTabs: [...GENERAL_TAB_KEYS],
  isSystem: true,
});
const SDR = caps({
  key: "sdr",
  dataScope: "all",
  allowedTabs: [...GENERAL_TAB_KEYS],
});

describe("canSeeAllData", () => {
  it("es true para admin y SDR (data_scope='all'), false para vendedor", () => {
    expect(canSeeAllData(ADMIN)).toBe(true);
    expect(canSeeAllData(SDR)).toBe(true);
    expect(canSeeAllData(VENDEDOR)).toBe(false);
  });
});

describe("canAccessAdminPanel", () => {
  it("true solo si el rol tiene alguna pestaña de administración", () => {
    expect(canAccessAdminPanel(ADMIN)).toBe(true);
    // SDR ve todos los datos pero NINGUNA pestaña de admin.
    expect(canAccessAdminPanel(SDR)).toBe(false);
    expect(canAccessAdminPanel(VENDEDOR)).toBe(false);
  });

  it("un rol custom con una sola pestaña de admin sí accede al panel", () => {
    expect(canAccessAdminPanel(caps({ allowedTabs: ["admin-metas"] }))).toBe(true);
  });
});

describe("hasTab", () => {
  it("refleja allowedTabs", () => {
    expect(hasTab(SDR, "pipeline")).toBe(true);
    expect(hasTab(SDR, "admin-usuarios")).toBe(false);
    expect(hasTab(ADMIN, "admin-roles")).toBe(true);
  });
});

describe("landingHref", () => {
  it("aterriza en la primera pestaña visible del rol", () => {
    expect(landingHref(SDR)).toBe("/mi-dia");
    expect(landingHref(caps({ allowedTabs: ["dashboard"] }))).toBe("/dashboard");
  });
  it("cae a /no-access si el rol no tiene pestañas (estado que la app impide)", () => {
    expect(landingHref(caps({ allowedTabs: [] }))).toBe("/no-access");
  });
});

describe("fallbackCapabilities", () => {
  it("admin/superadmin → todos los datos + todas las pestañas", () => {
    expect(canSeeAllData(fallbackCapabilities("admin"))).toBe(true);
    expect(canAccessAdminPanel(fallbackCapabilities("superadmin"))).toBe(true);
  });
  it("vendedor y desconocido → mínimo seguro (own, sin panel de admin)", () => {
    const v = fallbackCapabilities("vendedor");
    expect(canSeeAllData(v)).toBe(false);
    expect(canAccessAdminPanel(v)).toBe(false);
    const unknown = fallbackCapabilities("rol-raro");
    expect(canSeeAllData(unknown)).toBe(false);
    expect(canAccessAdminPanel(unknown)).toBe(false);
  });
});
