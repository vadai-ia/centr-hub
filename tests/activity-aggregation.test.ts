import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * "Última actividad en la plataforma" (correctivo M1v2): la CREACIÓN de una
 * tarea — sobre todo las automáticas de reglas — NO cuenta como actividad
 * (que el sistema cree una tarea no es seguimiento humano). Solo el
 * COMPLETADO cuenta, junto con el resto de señales reales (etapa, nota,
 * orden, reasignación manual). Estos tests fijan ese contrato sobre el reloj
 * de "Clientes silenciosos" / trigger no_activity.
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

import { withTenantContext } from "@/lib/tenant/context";
import {
  lastPlatformActivityForOpportunities,
  lastPlatformActivityForContacts,
} from "@/lib/services/activity-aggregation";

const ORG = "org-1";

beforeEach(() => {
  fake.reset();
  fake.setTable("opportunity_stage_history", []);
  fake.setTable("activities", []);
  fake.setTable("orders", []);
  fake.setTable("audit_log", []);
});

describe("lastPlatformActivityForOpportunities — creación de tarea no cuenta", () => {
  it("una tarea creada pero NO completada deja la opp SIN actividad (no resetea el reloj)", async () => {
    fake.setTable("tasks", [
      {
        id: "t1",
        organization_id: ORG,
        opportunity_id: "opp-1",
        created_at: "2026-06-15T10:00:00.000Z",
        completed_at: null,
      },
    ]);

    const map = await withTenantContext(
      ORG,
      () => lastPlatformActivityForOpportunities(["opp-1"]),
      { source: "test" },
    );
    expect(map.get("opp-1")).toBeNull();
  });

  it("una tarea COMPLETADA sí cuenta (acción humana)", async () => {
    fake.setTable("tasks", [
      {
        id: "t1",
        organization_id: ORG,
        opportunity_id: "opp-1",
        created_at: "2026-06-15T10:00:00.000Z",
        completed_at: "2026-06-16T09:00:00.000Z",
      },
    ]);

    const map = await withTenantContext(
      ORG,
      () => lastPlatformActivityForOpportunities(["opp-1"]),
      { source: "test" },
    );
    expect(map.get("opp-1")).toBe("2026-06-16T09:00:00.000Z");
  });

  it("el cambio de etapa sigue contando como actividad", async () => {
    fake.setTable("tasks", []);
    fake.setTable("opportunity_stage_history", [
      { organization_id: ORG, opportunity_id: "opp-1", changed_at: "2026-06-14T08:00:00.000Z" },
    ]);

    const map = await withTenantContext(
      ORG,
      () => lastPlatformActivityForOpportunities(["opp-1"]),
      { source: "test" },
    );
    expect(map.get("opp-1")).toBe("2026-06-14T08:00:00.000Z");
  });
});

describe("lastPlatformActivityForContacts — creación de tarea no cuenta", () => {
  it("tarea creada sin completar → contacto sin actividad; completarla sí cuenta", async () => {
    fake.setTable("opportunities", []);
    fake.setTable("tasks", [
      {
        id: "t1",
        organization_id: ORG,
        contact_id: "c-1",
        created_at: "2026-06-15T10:00:00.000Z",
        completed_at: null,
      },
    ]);

    let map = await withTenantContext(
      ORG,
      () => lastPlatformActivityForContacts(["c-1"]),
      { source: "test" },
    );
    expect(map.get("c-1")).toBeNull();

    fake.setTable("tasks", [
      {
        id: "t1",
        organization_id: ORG,
        contact_id: "c-1",
        created_at: "2026-06-15T10:00:00.000Z",
        completed_at: "2026-06-17T12:00:00.000Z",
      },
    ]);
    map = await withTenantContext(
      ORG,
      () => lastPlatformActivityForContacts(["c-1"]),
      { source: "test" },
    );
    expect(map.get("c-1")).toBe("2026-06-17T12:00:00.000Z");
  });
});
