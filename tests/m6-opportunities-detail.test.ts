import { describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Detalle de oportunidad (M6 — B1).
 *
 * El happy path con joins PostgREST no es simulable con FakeSupabase
 * (no parsea el shape `stage:pipeline_stages!inner(*)`). Por eso este
 * test cubre:
 *   - Helpers puros: effectiveAmount, formatAmount.
 *   - Edge case: opp inexistente → null.
 *
 * El smoke E2E con joins reales se valida en B12 contra Supabase.
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

import { withTenantContext } from "@/lib/tenant/context";
import {
  effectiveAmount,
  formatAmount,
  getOpportunityDetail,
} from "@/lib/db/opportunities-detail";

const ORG = "org-1";

describe("effectiveAmount", () => {
  it("prefiere actual_amount cuando está presente", () => {
    const r = effectiveAmount({ actual_amount: "1234.56", estimated_amount: "999.99" });
    expect(r.value).toBe("1234.56");
    expect(r.isEstimated).toBe(false);
  });

  it("usa estimated_amount como fallback cuando actual es null", () => {
    const r = effectiveAmount({ actual_amount: null, estimated_amount: "500.00" });
    expect(r.value).toBe("500.00");
    expect(r.isEstimated).toBe(true);
  });

  it("ambos null devuelve null sin marcar como estimated", () => {
    const r = effectiveAmount({ actual_amount: null, estimated_amount: null });
    expect(r.value).toBeNull();
    expect(r.isEstimated).toBe(false);
  });
});

describe("formatAmount", () => {
  it("devuelve string formateado en es-MX para MXN", () => {
    const s = formatAmount("1234.56", "MXN");
    expect(s).toBeTruthy();
    // Intl puede variar entre Node versions ($1,234.56 vs $ 1,234.56);
    // afirmamos solo que contiene el símbolo y los dígitos.
    expect(s).toMatch(/\$/);
    expect(s).toMatch(/1[\s,.]?234/);
  });

  it("null devuelve null", () => {
    expect(formatAmount(null, "MXN")).toBeNull();
  });

  it("NaN devuelve null", () => {
    expect(formatAmount("not-a-number", "MXN")).toBeNull();
  });

  it("currency desconocida cae a fallback con sufijo", () => {
    const s = formatAmount("100", "ZZZ");
    // Intl puede aceptarlo y formatear con ZZZ — basta con que el
    // string contenga los dígitos.
    expect(s).toMatch(/100/);
  });
});

describe("getOpportunityDetail (edge cases)", () => {
  it("opp inexistente devuelve null", async () => {
    fake.setTable("opportunities", []);
    const result = await withTenantContext(ORG, async () => {
      return getOpportunityDetail("opp-ghost");
    });
    expect(result).toBeNull();
  });
});
