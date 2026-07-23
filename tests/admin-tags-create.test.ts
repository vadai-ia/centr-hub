import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/tenant/context", () => ({
  withTenantContext: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/auth/admin-guard", () => ({ resolveAdminContext: vi.fn() }));
vi.mock("@/lib/db/configuration", () => ({
  getTagMappingByNormalized: vi.fn(),
  upsertTagMapping: vi.fn(),
  listTagMappings: vi.fn(),
  deleteTagMappingByNormalized: vi.fn(),
}));
vi.mock("@/lib/db/users", () => ({ listRealVendorsForMapping: vi.fn() }));
vi.mock("@/lib/db/tag-aggregation", () => ({
  aggregateDetectedTags: vi.fn(),
  findContactsWithTag: vi.fn(),
  findOrdersWithTag: vi.fn(),
  reattributeContacts: vi.fn(),
  reattributeOrders: vi.fn(),
}));
vi.mock("@/lib/db/operational", () => ({ recordAuditEvent: vi.fn() }));
vi.mock("@/lib/inngest/client", () => ({ getInngestClient: vi.fn() }));
vi.mock("@/lib/inngest/functions/tag-reprocess", () => ({
  PLATFORM_TAG_REPROCESS_EVENT: "platform/tag.reprocess",
}));

import { createTagMappingAction } from "@/lib/actions/admin-tags";
import { resolveAdminContext } from "@/lib/auth/admin-guard";
import {
  getTagMappingByNormalized,
  upsertTagMapping,
  listTagMappings,
} from "@/lib/db/configuration";
import { listRealVendorsForMapping } from "@/lib/db/users";
import { aggregateDetectedTags } from "@/lib/db/tag-aggregation";

const ORG = "org-1";
const USER = "user-admin";
const VENDOR = "22222222-2222-4222-8222-222222222222";

const mAdmin = vi.mocked(resolveAdminContext);
const mGet = vi.mocked(getTagMappingByNormalized);
const mUpsert = vi.mocked(upsertTagMapping);
const mVendors = vi.mocked(listRealVendorsForMapping);

beforeEach(() => {
  vi.clearAllMocks();
  mAdmin.mockResolvedValue({
    ok: true,
    ctx: { orgId: ORG, userId: USER, role: { key: "admin" } },
  } as never);
  mVendors.mockResolvedValue([
    { id: VENDOR, profile: { full_name: "Vendedor Uno" }, is_active: true } as never,
  ]);
  mGet.mockResolvedValue(null); // por defecto, la tag no existe
  mUpsert.mockResolvedValue({ id: "row" } as never);
  // Reload post-acción (loadAdminTagMappings).
  vi.mocked(aggregateDetectedTags).mockResolvedValue([]);
  vi.mocked(listTagMappings).mockResolvedValue([]);
});

describe("createTagMappingAction (Bloque B)", () => {
  it("crea una fila nueva, normalizando la tag (trim + lowercase)", async () => {
    const res = await createTagMappingAction({
      tag: "  Juan Perez  ",
      classification: "vendor",
      membershipId: VENDOR,
    });
    expect(res.ok).toBe(true);
    // Anti-duplicado consulta por la forma normalizada.
    expect(mGet).toHaveBeenCalledWith("juan perez");
    // Se persiste normalized lowercased + original tal como se tecleó (trim).
    expect(mUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        normalized_tag: "juan perez",
        original_tag: "Juan Perez",
        classification: "vendor",
        mapped_membership_id: VENDOR,
      }),
    );
  });

  it("bloquea si ya existe un mapeo para esa tag (anti-duplicado)", async () => {
    mGet.mockResolvedValue({ id: "existing" } as never);
    const res = await createTagMappingAction({
      tag: "Cotización",
      classification: "vendor",
      membershipId: VENDOR,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/ya existe/i);
    expect(mUpsert).not.toHaveBeenCalled();
  });

  it("exige vendedor cuando la clasificación es De vendedor", async () => {
    const res = await createTagMappingAction({ tag: "nueva", classification: "vendor" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/vendedor/i);
    expect(mUpsert).not.toHaveBeenCalled();
  });

  it("rechaza un vendedor que no es real (defensa R10)", async () => {
    const res = await createTagMappingAction({
      tag: "nueva",
      classification: "vendor",
      membershipId: "33333333-3333-4333-8333-333333333333",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/no es válido/i);
  });

  it("permite crear una tag informativa sin vendedor", async () => {
    const res = await createTagMappingAction({ tag: "Facturado", classification: "informational" });
    expect(res.ok).toBe(true);
    expect(mUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        normalized_tag: "facturado",
        classification: "informational",
        mapped_membership_id: null,
      }),
    );
  });
});
