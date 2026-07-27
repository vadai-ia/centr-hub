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

describe("buildOutboundBody — omitir null (fix Whaapy 400)", () => {
  it("email null → NO incluye la clave email (nunca la manda como null)", () => {
    const body = buildOutboundBody(snap({ email: null }), null);
    expect("email" in body).toBe(false);
    expect(body.phone_number).toBe("+525512345678");
    expect(body.name).toBe("Juan");
  });

  it("name null → NO incluye la clave name", () => {
    const body = buildOutboundBody(snap({ fullName: null }), null);
    expect("name" in body).toBe(false);
    expect(body.email).toBe("juan@x.com");
  });

  it("ambos null → solo phone_number + custom_fields", () => {
    const body = buildOutboundBody(snap({ fullName: null, email: null }), null);
    expect("name" in body).toBe(false);
    expect("email" in body).toBe(false);
    expect(body.phone_number).toBe("+525512345678");
    expect(body.custom_fields).toHaveProperty("last_platform_write_at");
  });

  it("campos presentes → se incluyen como string (no null)", () => {
    const body = buildOutboundBody(snap({ fullName: "Ana", email: "ana@x.com" }), "agent-1");
    expect(body.name).toBe("Ana");
    expect(body.email).toBe("ana@x.com");
    expect(body.assigned_agent_id).toBe("agent-1");
  });

  it("assigned_agent_id null → se omite", () => {
    const body = buildOutboundBody(snap(), null);
    expect("assigned_agent_id" in body).toBe(false);
  });

  it("ningún valor del body es null (invariante anti-400)", () => {
    const body = buildOutboundBody(snap({ fullName: null, email: null }), null) as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(body)) {
      expect(v, `campo ${k} no debe ser null`).not.toBeNull();
    }
  });
});
