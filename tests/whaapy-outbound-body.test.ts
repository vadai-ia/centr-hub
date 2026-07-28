import { describe, it, expect } from "vitest";
import { buildOutboundBody } from "@/lib/inngest/functions/whaapy-outbound";
import type { WhaapyContactSyncEnvelope } from "@/lib/inngest/client";

/**
 * `buildOutboundBody` — Whaapy valida los campos opcionales como `string` y
 * RECHAZA `null` con 400 "Expected string, received null" (solo phone_number
 * es requerido). Los nullables (name, email) DEBEN omitirse cuando son null,
 * nunca enviarse como null. Ver ERRORES.md "Whaapy 400 por email:null".
 */

type Snapshot = WhaapyContactSyncEnvelope["contactSnapshot"];

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    shopifyCustomerId: null,
    whaapyContactId: null,
    fullName: "Juan",
    email: "juan@x.com",
    phone: "+525512345678",
    address: null,
    internalNote: null,
    shopifyTags: [],
    shopifyState: null,
    assignedAdvisorId: null,
    fieldMetadata: {},
    lastModifiedAt: "2026-07-01T00:00:00Z",
    lastModifiedSource: "platform",
    ...overrides,
  };
}

const OMIT = { kind: "omit" } as const;

describe("buildOutboundBody — omitir null (fix Whaapy 400)", () => {
  it("email null → NO incluye la clave email (nunca la manda como null)", () => {
    const body = buildOutboundBody(snap({ email: null }), OMIT);
    expect("email" in body).toBe(false);
    expect(body.phone_number).toBe("+525512345678");
    expect(body.name).toBe("Juan");
  });

  it("name null → NO incluye la clave name", () => {
    const body = buildOutboundBody(snap({ fullName: null }), OMIT);
    expect("name" in body).toBe(false);
    expect(body.email).toBe("juan@x.com");
  });

  it("ambos null → solo phone_number + custom_fields", () => {
    const body = buildOutboundBody(snap({ fullName: null, email: null }), OMIT);
    expect("name" in body).toBe(false);
    expect("email" in body).toBe(false);
    expect(body.phone_number).toBe("+525512345678");
    expect(body.custom_fields).toHaveProperty("last_platform_write_at");
  });

  it("campos presentes → se incluyen como string (no null)", () => {
    const body = buildOutboundBody(snap({ fullName: "Ana", email: "ana@x.com" }), { kind: "set", id: "agent-1" });
    expect(body.name).toBe("Ana");
    expect(body.email).toBe("ana@x.com");
    expect(body.assigned_agent_id).toBe("agent-1");
  });

  it("name/email NUNCA se envían como null (invariante anti-400)", () => {
    // El agente puede ir como null (clear); name/email jamás.
    const body = buildOutboundBody(snap({ fullName: null, email: null }), { kind: "clear" }) as unknown as Record<string, unknown>;
    expect(body.name ?? undefined).not.toBeNull();
    expect(body.email ?? undefined).not.toBeNull();
    for (const k of ["name", "email"]) {
      if (k in body) expect(body[k], `campo ${k} no debe ser null`).not.toBeNull();
    }
  });
});

describe("buildOutboundBody — directiva tri-estado del agente (bug 3)", () => {
  it("omit → NO incluye la clave assigned_agent_id", () => {
    const body = buildOutboundBody(snap(), OMIT);
    expect("assigned_agent_id" in body).toBe(false);
  });

  it("set → assigned_agent_id = id (string)", () => {
    const body = buildOutboundBody(snap(), { kind: "set", id: "agent-9" });
    expect(body.assigned_agent_id).toBe("agent-9");
  });

  it("clear → assigned_agent_id = null (desasignar en Whaapy)", () => {
    const body = buildOutboundBody(snap(), { kind: "clear" });
    expect("assigned_agent_id" in body).toBe(true);
    expect(body.assigned_agent_id).toBeNull();
  });
});
