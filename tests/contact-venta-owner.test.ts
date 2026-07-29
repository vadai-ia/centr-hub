import { describe, it, expect } from "vitest";
import { computeVentaContactOwner } from "@/lib/services/contact-advisor-sync";
import type { UUID } from "@/lib/types/database";

const X = "11111111-1111-4111-8111-111111111111" as UUID;
const Y = "22222222-2222-4222-8222-222222222222" as UUID;

/**
 * Guard del recompute del dueño-Venta del contacto (decisiones del operador):
 * Ganadas cuentan (ya vienen filtradas por el query), Perdidas/Canceladas no;
 * 1 asesor → ese; 0 → desasigna; conflicto → explicit-wins; desasignación
 * hacia conflicto → conserva el actual.
 */
describe("computeVentaContactOwner", () => {
  it("una sola opp de Venta asignada → ese asesor", () => {
    expect(
      computeVentaContactOwner({ ventaAdvisorIds: [X], justAssignedAdvisorId: X, currentOwnerId: null }),
    ).toBe(X);
  });

  it("sin opps de Venta con asesor → desasigna (null)", () => {
    expect(
      computeVentaContactOwner({ ventaAdvisorIds: [null, null], justAssignedAdvisorId: null, currentOwnerId: X }),
    ).toBeNull();
  });

  it("desasignar la única opp → null (clear)", () => {
    // Tras desasignar, no quedan asesores en las opps de Venta activas.
    expect(
      computeVentaContactOwner({ ventaAdvisorIds: [], justAssignedAdvisorId: null, currentOwnerId: X }),
    ).toBeNull();
  });

  it("desasignar una opp pero otra Venta sigue con asesor → ese otro", () => {
    expect(
      computeVentaContactOwner({ ventaAdvisorIds: [Y], justAssignedAdvisorId: null, currentOwnerId: X }),
    ).toBe(Y);
  });

  it("conflicto (2 opps distintas) al ASIGNAR → gana el recién asignado", () => {
    expect(
      computeVentaContactOwner({ ventaAdvisorIds: [X, Y], justAssignedAdvisorId: Y, currentOwnerId: X }),
    ).toBe(Y);
  });

  it("conflicto al DESASIGNAR (justAssigned null) → conserva el dueño actual", () => {
    expect(
      computeVentaContactOwner({ ventaAdvisorIds: [X, Y], justAssignedAdvisorId: null, currentOwnerId: X }),
    ).toBe(X);
  });

  it("mismo asesor duplicado en varias opps → ese (no es conflicto)", () => {
    expect(
      computeVentaContactOwner({ ventaAdvisorIds: [X, X], justAssignedAdvisorId: X, currentOwnerId: null }),
    ).toBe(X);
  });
});
