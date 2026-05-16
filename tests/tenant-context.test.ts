import { describe, expect, it } from "vitest";
import {
  runWithTenantContext,
  requireTenantContext,
  getCurrentOrganizationId,
  tryGetTenantContext,
  TenantContextRequiredError,
} from "@/lib/tenant/context";

const ORG_A = "00000000-0000-0000-0000-000000000001";
const ORG_B = "00000000-0000-0000-0000-000000000002";

describe("tenant context (Barrera 2)", () => {
  it("lanza TenantContextRequiredError fuera del wrapper", () => {
    expect(() => requireTenantContext()).toThrowError(TenantContextRequiredError);
    expect(() => getCurrentOrganizationId()).toThrowError(TenantContextRequiredError);
  });

  it("tryGetTenantContext devuelve null fuera del wrapper", () => {
    expect(tryGetTenantContext()).toBeNull();
  });

  it("expone el organization_id activo dentro del wrapper", () => {
    runWithTenantContext(ORG_A, () => {
      expect(getCurrentOrganizationId()).toBe(ORG_A);
      const ctx = requireTenantContext();
      expect(ctx.organizationId).toBe(ORG_A);
      expect(ctx.source).toBe("test");
    });
  });

  it("aisla contextos anidados (orgB no se mezcla con orgA)", () => {
    runWithTenantContext(ORG_A, () => {
      expect(getCurrentOrganizationId()).toBe(ORG_A);
      runWithTenantContext(ORG_B, () => {
        expect(getCurrentOrganizationId()).toBe(ORG_B);
      });
      // Al salir del nested, recupera contexto exterior.
      expect(getCurrentOrganizationId()).toBe(ORG_A);
    });
  });

  it("rechaza organizationId vacío", () => {
    expect(() =>
      runWithTenantContext("" as string, () => undefined),
    ).toThrowError(TenantContextRequiredError);
  });

  it("aisla contextos en callbacks async concurrentes", async () => {
    const promiseA = new Promise<string>((resolve) => {
      runWithTenantContext(ORG_A, () => {
        // micro-task delay para forzar interleaving
        Promise.resolve().then(() => resolve(getCurrentOrganizationId()));
      });
    });

    const promiseB = new Promise<string>((resolve) => {
      runWithTenantContext(ORG_B, () => {
        Promise.resolve().then(() => resolve(getCurrentOrganizationId()));
      });
    });

    const [a, b] = await Promise.all([promiseA, promiseB]);
    expect(a).toBe(ORG_A);
    expect(b).toBe(ORG_B);
  });
});
