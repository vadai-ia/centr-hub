import { describe, it, expect } from "vitest";
import { decideAgentAdvisorSync } from "@/lib/services/whaapy-agent-sync";
import type { UUID } from "@/lib/types/database";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;

/**
 * Sync agente-Whaapy → asesor-plataforma (contact.updated). Guard de la
 * decisión pura: set/change/clear + no-tocar cuando el agente no cambió +
 * mapping_missing sin borrar + idempotencia.
 */
describe("decideAgentAdvisorSync", () => {
  it("agente NO cambió (updated_fields sin assignedAgentId) → no toca el asesor", () => {
    const d = decideAgentAdvisorSync({
      agentFieldChanged: false,
      snapshotAgentId: "agent-x",
      currentAdvisorId: A,
      mappedMembershipId: B,
    });
    expect(d.changed).toBe(false);
    expect(d.nextAdvisorId).toBe(A);
    expect(d.audit).toBeNull();
  });

  it("agente nuevo mapeado → SET al asesor mapeado", () => {
    const d = decideAgentAdvisorSync({
      agentFieldChanged: true,
      snapshotAgentId: "agent-b",
      currentAdvisorId: null,
      mappedMembershipId: B,
    });
    expect(d.changed).toBe(true);
    expect(d.nextAdvisorId).toBe(B);
    expect(d.audit).toBe("synced");
  });

  it("agente cambió a otro mapeado → CHANGE (Whaapy gana)", () => {
    const d = decideAgentAdvisorSync({
      agentFieldChanged: true,
      snapshotAgentId: "agent-b",
      currentAdvisorId: A,
      mappedMembershipId: B,
    });
    expect(d.changed).toBe(true);
    expect(d.nextAdvisorId).toBe(B);
    expect(d.audit).toBe("synced");
  });

  it("mismo agente mapeado que ya tiene → idempotente (no cambia)", () => {
    const d = decideAgentAdvisorSync({
      agentFieldChanged: true,
      snapshotAgentId: "agent-a",
      currentAdvisorId: A,
      mappedMembershipId: A,
    });
    expect(d.changed).toBe(false);
    expect(d.audit).toBeNull();
  });

  it("agente presente pero SIN mapeo → no toca el asesor, señala mapping_missing", () => {
    const d = decideAgentAdvisorSync({
      agentFieldChanged: true,
      snapshotAgentId: "agent-unmapped",
      currentAdvisorId: A,
      mappedMembershipId: null,
    });
    expect(d.changed).toBe(false);
    expect(d.nextAdvisorId).toBe(A); // no se borra un asesor válido
    expect(d.audit).toBe("mapping_missing");
  });

  it("agente removido en Whaapy (null) con asesor → CLEAR (desasigna)", () => {
    const d = decideAgentAdvisorSync({
      agentFieldChanged: true,
      snapshotAgentId: null,
      currentAdvisorId: A,
      mappedMembershipId: null,
    });
    expect(d.changed).toBe(true);
    expect(d.nextAdvisorId).toBeNull();
    expect(d.audit).toBe("synced");
  });

  it("agente removido en Whaapy pero ya estaba sin asesor → no cambia", () => {
    const d = decideAgentAdvisorSync({
      agentFieldChanged: true,
      snapshotAgentId: null,
      currentAdvisorId: null,
      mappedMembershipId: null,
    });
    expect(d.changed).toBe(false);
    expect(d.audit).toBeNull();
  });
});
