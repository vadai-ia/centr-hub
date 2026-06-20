import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Cierre de "Caso problemático" de Post-venta (M3v2, Bloque E).
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

import { withTenantContext } from "@/lib/tenant/context";
import { resolvePostventaCase } from "@/lib/services/postventa-case-resolution";

const ORG = "org-1";
const USER = "user-admin-1";
const PROBLEMATICO = "pv-7-caso-problematico";
const ENTREGADO = "pv-4-entregado";

function seedStages() {
  const def = (id: string, name: string, position: number) => ({
    id,
    organization_id: ORG,
    funnel: "post_venta",
    name,
    position,
    is_initial: position === 1,
    is_won: false,
    is_lost: false,
    is_active: true,
  });
  fake.setTable("pipeline_stages", [
    def("pv-1", "Cotización completada", 1),
    def("pv-2", "Pago confirmado", 2),
    def("pv-3", "Envío en curso", 3),
    def(ENTREGADO, "Entregado", 4),
    def("pv-5", "Seguimiento post-entrega", 5),
    def("pv-6", "Cliente activo", 6),
    def(PROBLEMATICO, "Caso problemático", 7),
  ]);
}

function seedOpp(overrides: Record<string, unknown> = {}) {
  fake.setTable("opportunities", [
    {
      id: "opp-1",
      organization_id: ORG,
      funnel: "post_venta",
      stage_id: PROBLEMATICO,
      contact_id: "contact-1",
      assigned_advisor_id: "advisor-9",
      resolved_at: null,
      resolved_by_user_id: null,
      resolution_note: null,
      last_modified_at: "2026-06-01T00:00:00Z",
      ...overrides,
    },
  ]);
}

function oppRow() {
  return fake.getTable("opportunities")[0] as Record<string, unknown>;
}

const run = <T>(fn: () => Promise<T>) => withTenantContext(ORG, fn, { source: "worker" });

beforeEach(() => {
  fake.reset();
  seedStages();
});

describe("resolvePostventaCase", () => {
  it("resuelve un caso en Caso problemático → setea resolved_*, preserva etapa", async () => {
    seedOpp({ stage_id: PROBLEMATICO });
    const r = await run(() =>
      resolvePostventaCase({
        opportunityId: "opp-1",
        resolvedByUserId: USER,
        note: "  Reembolso procesado, cliente conforme  ",
      }),
    );
    expect(r.ok).toBe(true);
    const row = oppRow();
    expect(row.resolved_at).toBeTruthy();
    expect(row.resolved_by_user_id).toBe(USER);
    expect(row.resolution_note).toBe("Reembolso procesado, cliente conforme"); // trimmed
    // etapa preservada
    expect(row.stage_id).toBe(PROBLEMATICO);
    // atribución intacta
    expect(row.assigned_advisor_id).toBe("advisor-9");
  });

  it("nota vacía se guarda como null", async () => {
    seedOpp({ stage_id: PROBLEMATICO });
    await run(() =>
      resolvePostventaCase({ opportunityId: "opp-1", resolvedByUserId: USER, note: "   " }),
    );
    expect(oppRow().resolution_note).toBeNull();
  });

  it("registra audit postventa_case_resolved", async () => {
    seedOpp({ stage_id: PROBLEMATICO });
    await run(() =>
      resolvePostventaCase({ opportunityId: "opp-1", resolvedByUserId: USER }),
    );
    const audits = fake.getTable("audit_log");
    expect(audits.some((a) => (a as { event_type: string }).event_type === "postventa_case_resolved")).toBe(true);
  });

  it("idempotente: ya resuelto → already_resolved", async () => {
    seedOpp({ stage_id: PROBLEMATICO, resolved_at: "2026-06-10T00:00:00Z" });
    const r = await run(() =>
      resolvePostventaCase({ opportunityId: "opp-1", resolvedByUserId: USER }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("already_resolved");
  });

  it("opp NO en Caso problemático → not_in_problematic", async () => {
    seedOpp({ stage_id: ENTREGADO });
    const r = await run(() =>
      resolvePostventaCase({ opportunityId: "opp-1", resolvedByUserId: USER }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_in_problematic");
  });

  it("opp de Venta → not_post_venta", async () => {
    seedOpp({ stage_id: PROBLEMATICO, funnel: "venta" });
    const r = await run(() =>
      resolvePostventaCase({ opportunityId: "opp-1", resolvedByUserId: USER }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_post_venta");
  });

  it("opp inexistente → not_found", async () => {
    seedOpp({ stage_id: PROBLEMATICO });
    const r = await run(() =>
      resolvePostventaCase({ opportunityId: "nope", resolvedByUserId: USER }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });
});
