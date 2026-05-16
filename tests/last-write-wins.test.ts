import { describe, expect, it } from "vitest";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  shouldApplyRecordUpdate,
  buildFieldMetadataPatch,
} from "@/lib/services/last-write-wins";

describe("last-write-wins helpers (R3 record-level)", () => {
  it("requiere tenant context para shouldApplyRecordUpdate", () => {
    expect(() => shouldApplyRecordUpdate(null, "2026-05-01T00:00:00Z")).toThrow();
  });

  it("aplica update si local es null y payload tiene timestamp", () => {
    runWithTenantContext("org", () => {
      expect(shouldApplyRecordUpdate(null, "2026-05-01T00:00:00Z")).toBe(true);
    });
  });

  it("ignora payload sin timestamp", () => {
    runWithTenantContext("org", () => {
      expect(shouldApplyRecordUpdate("2026-05-01T00:00:00Z", null)).toBe(false);
    });
  });

  it("aplica solo si payload > local", () => {
    runWithTenantContext("org", () => {
      expect(
        shouldApplyRecordUpdate(
          "2026-05-01T00:00:00Z",
          "2026-05-02T00:00:00Z",
        ),
      ).toBe(true);
      expect(
        shouldApplyRecordUpdate(
          "2026-05-02T00:00:00Z",
          "2026-05-01T00:00:00Z",
        ),
      ).toBe(false);
      expect(
        shouldApplyRecordUpdate(
          "2026-05-02T00:00:00Z",
          "2026-05-02T00:00:00Z",
        ),
      ).toBe(false);
    });
  });
});

describe("buildFieldMetadataPatch", () => {
  it("agrega entrada nueva sobre objeto vacío", () => {
    const patch = buildFieldMetadataPatch({}, "email", "2026-05-01T00:00:00Z", "shopify");
    expect(patch).toEqual({
      email: { updated_at: "2026-05-01T00:00:00Z", source: "shopify" },
    });
  });

  it("preserva campos existentes al actualizar uno", () => {
    const current = {
      full_name: { updated_at: "2026-04-01T00:00:00Z", source: "shopify" },
    };
    const patch = buildFieldMetadataPatch(current, "email", "2026-05-01T00:00:00Z", "whaapy");
    expect(patch).toEqual({
      full_name: { updated_at: "2026-04-01T00:00:00Z", source: "shopify" },
      email: { updated_at: "2026-05-01T00:00:00Z", source: "whaapy" },
    });
  });

  it("trata null y arrays como objeto vacío", () => {
    expect(
      buildFieldMetadataPatch(null, "email", "2026-05-01T00:00:00Z", "shopify"),
    ).toEqual({ email: { updated_at: "2026-05-01T00:00:00Z", source: "shopify" } });
    expect(
      buildFieldMetadataPatch([], "email", "2026-05-01T00:00:00Z", "shopify"),
    ).toEqual({ email: { updated_at: "2026-05-01T00:00:00Z", source: "shopify" } });
  });
});
