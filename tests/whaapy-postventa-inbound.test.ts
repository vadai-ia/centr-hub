import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FASE 2 (Option A, hardened) — worker inbound del Whaapy de Post-venta.
 * El trigger es la Automation en "Caso Resuelto" y solo llega el teléfono.
 * Resolución SIN adivinanza: candidatos = opps del contacto en "Caso
 * problemático" no resueltas; se resuelve solo si hay EXACTAMENTE 1; con
 * ≥2 se deriva a revisión manual (no auto-archiva). Verifica también el
 * scope a "Caso problemático" y el anti-bucle capa 1 (source inbound).
 */

vi.mock("@/lib/db/operational", () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
  createNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/whaapy-postventa/resolver-user", () => ({
  resolvePostventaResolverUserId: vi.fn(),
}));
vi.mock("@/lib/services/postventa-case-resolution", () => ({
  resolvePostventaCase: vi.fn(),
}));
vi.mock("@/lib/db/contacts", () => ({
  findContactByPhoneOrEmail: vi.fn(),
}));
vi.mock("@/lib/db/opportunities", () => ({
  listOpportunities: vi.fn(),
}));
vi.mock("@/lib/services/dashboard-stages", () => ({
  resolvePostventaStages: vi.fn(),
}));

import { processPostventaInbound } from "@/lib/inngest/functions/whaapy-postventa-inbound";
import { recordAuditEvent, createNotification } from "@/lib/db/operational";
import { resolvePostventaResolverUserId } from "@/lib/whaapy-postventa/resolver-user";
import { resolvePostventaCase } from "@/lib/services/postventa-case-resolution";
import { findContactByPhoneOrEmail } from "@/lib/db/contacts";
import { listOpportunities } from "@/lib/db/opportunities";
import { resolvePostventaStages } from "@/lib/services/dashboard-stages";
import type { WhaapyPostventaInboundEnvelope } from "@/lib/inngest/client";

const mock = <T extends (...a: never[]) => unknown>(fn: T) =>
  fn as unknown as ReturnType<typeof vi.fn>;

const ORG = "org-1";
const PROB = "prob-stage";

function env(
  over: Partial<WhaapyPostventaInboundEnvelope> = {},
): WhaapyPostventaInboundEnvelope {
  return {
    organizationId: ORG,
    deliveryId: "auto-1",
    receivedAt: "2026-07-08T00:00:00Z",
    opportunityId: null,
    phone: null,
    ...over,
  };
}

function auditTypes(): string[] {
  return mock(recordAuditEvent).mock.calls.map(
    (c) => (c[0] as { eventType: string }).eventType,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mock(resolvePostventaResolverUserId).mockResolvedValue("cs-user");
  mock(resolvePostventaCase).mockResolvedValue({ ok: true, opportunity: {} });
  mock(resolvePostventaStages).mockResolvedValue({ problematicStage: { id: PROB } });
  mock(findContactByPhoneOrEmail).mockResolvedValue({ id: "contact-1" });
  mock(listOpportunities).mockResolvedValue([]);
});

describe("processPostventaInbound (Option A, count-based)", () => {
  it("fast-path: opportunity_id explícito → resuelve con source inbound", async () => {
    const r = await processPostventaInbound(env({ opportunityId: "opp-1" }));
    expect(r).toMatchObject({ opportunityId: "opp-1", resolved: true });
    expect(resolvePostventaCase).toHaveBeenCalledWith({
      opportunityId: "opp-1",
      resolvedByUserId: "cs-user",
      note: "Resuelto en Whaapy Post-venta",
      source: "whaapy_postventa_inbound",
    });
    expect(findContactByPhoneOrEmail).not.toHaveBeenCalled();
  });

  it("teléfono + exactamente 1 caso activo en Caso problemático → resuelve", async () => {
    mock(listOpportunities).mockResolvedValue([{ id: "opp-9", resolved_at: null }]);
    const r = await processPostventaInbound(env({ phone: "+525512345678" }));
    expect(r).toMatchObject({ opportunityId: "opp-9", resolved: true });
    // Scope: consultó SOLO la etapa Caso problemático.
    expect(mock(listOpportunities).mock.calls[0][0]).toMatchObject({
      funnel: "post_venta",
      stageId: PROB,
      contactId: "contact-1",
    });
    expect(mock(resolvePostventaCase).mock.calls[0][0]).toMatchObject({
      opportunityId: "opp-9",
      source: "whaapy_postventa_inbound",
    });
  });

  it("≥2 casos activos → NO auto-archiva; deriva a revisión manual + notifica", async () => {
    mock(listOpportunities).mockResolvedValue([
      { id: "opp-9", resolved_at: null },
      { id: "opp-10", resolved_at: null },
    ]);
    const r = await processPostventaInbound(env({ phone: "+525512345678" }));
    expect(r).toMatchObject({ discarded: true, reason: "ambiguous_multiple_cases" });
    expect(resolvePostventaCase).not.toHaveBeenCalled();
    expect(auditTypes()).toContain("postventa_whaapy_inbound_needs_manual_review");
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(mock(createNotification).mock.calls[0][0]).toMatchObject({
      user_id: "cs-user",
      contact_id: "contact-1",
    });
  });

  it("resueltas NO cuentan como candidatas (filtro resolved_at)", async () => {
    mock(listOpportunities).mockResolvedValue([
      { id: "opp-9", resolved_at: null },
      { id: "opp-8", resolved_at: "2026-06-01T00:00:00Z" }, // ya resuelta → no candidata
    ]);
    const r = await processPostventaInbound(env({ phone: "+525512345678" }));
    // Solo 1 activa → resuelve esa, sin ambigüedad.
    expect(r).toMatchObject({ opportunityId: "opp-9", resolved: true });
  });

  it("0 casos activos → no-op (no_match)", async () => {
    mock(listOpportunities).mockResolvedValue([]);
    const r = await processPostventaInbound(env({ phone: "+525512345678" }));
    expect(r).toMatchObject({ discarded: true });
    expect(resolvePostventaCase).not.toHaveBeenCalled();
  });

  it("sin teléfono ni opp_id → no_match", async () => {
    const r = await processPostventaInbound(env());
    expect(r).toMatchObject({ discarded: true, reason: "missing_phone" });
    expect(resolvePostventaCase).not.toHaveBeenCalled();
  });

  it("sin Customer Success mapeado → discard, no resuelve", async () => {
    mock(resolvePostventaResolverUserId).mockResolvedValue(null);
    const r = await processPostventaInbound(env({ opportunityId: "opp-1" }));
    expect(r).toMatchObject({ discarded: true, reason: "resolver_unresolved" });
    expect(resolvePostventaCase).not.toHaveBeenCalled();
  });
});
