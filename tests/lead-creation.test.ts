import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";
import type { ContactRow, Json } from "@/lib/types/database";

/**
 * Camino canónico de creación de leads (0038) — orquestación de `createLead`.
 *
 * Cubre los cinco casos de validación del prompt: contacto nuevo, contacto
 * existente (enlace), contacto con opp activa en otra etapa (se respeta), lead
 * sin email/dirección, y asesor reflejado en Whaapy. Se mockean las piezas
 * periféricas (identity match, round-robin/Redis, enqueue Whaapy) para hacer
 * la orquestación determinista; el resto corre contra FakeSupabase.
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdminClient: () => fake }));

vi.mock("@/lib/services/identity-matching", () => ({
  normalizePhone: vi.fn((raw: string | null) => (raw && raw !== "bad" ? String(raw).trim() : null)),
  normalizeEmail: vi.fn((e: string | null) => (e ? String(e).trim().toLowerCase() : null)),
  matchLeadIdentity: vi.fn(),
}));
vi.mock("@/lib/services/lead-advisor-assignment", () => ({
  pickRoundRobinAdvisor: vi.fn(),
}));
vi.mock("@/lib/db/users", () => ({
  listActiveRealVendors: vi.fn(),
}));
vi.mock("@/lib/inngest/functions/customers", () => ({
  recordWhaapySyncIntent: vi.fn(),
}));

import { withTenantContext } from "@/lib/tenant/context";
import { createLead, LeadValidationError } from "@/lib/services/lead-creation";
import { matchLeadIdentity } from "@/lib/services/identity-matching";
import { pickRoundRobinAdvisor } from "@/lib/services/lead-advisor-assignment";
import { listActiveRealVendors } from "@/lib/db/users";
import { recordWhaapySyncIntent } from "@/lib/inngest/functions/customers";

const ORG = "org-1";
const INITIAL_STAGE = "stage-lead-nuevo";
const OUTBOUND_STAGE = "stage-cliente-contactado";
const ADV = "adv-1";
const PHONE = "+525512345678";

function seedStages() {
  fake.setTable("pipeline_stages", [
    { id: INITIAL_STAGE, organization_id: ORG, funnel: "venta", name: "Lead nuevo", is_initial: true },
    { id: OUTBOUND_STAGE, organization_id: ORG, funnel: "outbound", name: "Cliente contactado", is_initial: true },
  ]);
}

function existingContact(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: "ex-1",
    organization_id: ORG,
    full_name: "Existente",
    email: null,
    phone: PHONE,
    address: null,
    internal_note: null,
    shopify_tags: [],
    shopify_state: null,
    assigned_advisor_id: null,
    shopify_customer_id: null,
    whaapy_contact_id: null,
    field_metadata: {} as Json,
    last_modified_at: "2026-05-01T00:00:00Z",
    last_modified_source: "whaapy",
    missing_phone: false,
    deleted_in_shopify: false,
    deleted_in_whaapy: false,
    anonymized_at: null,
    last_whaapy_activity_at: null,
    is_outbound: false,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.reset();
  seedStages();
  vi.mocked(listActiveRealVendors).mockResolvedValue([
    { id: ADV } as never,
  ]);
  vi.mocked(pickRoundRobinAdvisor).mockResolvedValue({ advisorId: ADV, poolSize: 1 });
  vi.mocked(recordWhaapySyncIntent).mockResolvedValue(undefined);
});

describe("createLead — casos de validación", () => {
  it("caso 1: contacto NUEVO → crea contacto + opp en Lead nuevo con asesor + enqueue Whaapy (create)", async () => {
    vi.mocked(matchLeadIdentity).mockResolvedValue({
      recommendation: "create_new",
      match: null,
      normalizedPhone: PHONE,
      normalizedEmail: "a@b.com",
    });

    const res = await withTenantContext(ORG, () =>
      createLead({
        fullName: "Nuevo Lead",
        phone: PHONE,
        email: "A@B.com",
        assignment: { mode: "explicit", advisorId: ADV },
        source: "manual",
        actorUserId: "user-1",
      }),
    );

    expect(res.contactCreated).toBe(true);
    expect(res.opportunityCreated).toBe(true);
    expect(res.assignedAdvisorId).toBe(ADV);

    const opps = fake.getTable("opportunities");
    expect(opps).toHaveLength(1);
    expect(opps[0].stage_id).toBe(INITIAL_STAGE);
    expect(opps[0].assigned_advisor_id).toBe(ADV);
    expect(opps[0].lead_source).toBe("manual");

    const audit = fake.getTable("audit_log");
    expect(audit.some((a) => a.event_type === "lead_created")).toBe(true);

    // Caso 5 (parte): asesor reflejado en Whaapy con reason de CREACIÓN.
    expect(recordWhaapySyncIntent).toHaveBeenCalledTimes(1);
    const [contactArg, reasonArg] = vi.mocked(recordWhaapySyncIntent).mock.calls[0];
    expect((contactArg as ContactRow).assigned_advisor_id).toBe(ADV);
    expect(reasonArg).toBe("create_from_platform_ui");
  });

  it("caso 2: contacto EXISTENTE (lead sin asesor) → enlaza, setea asesor, crea opp", async () => {
    const ex = existingContact({ id: "ex-2", assigned_advisor_id: null });
    fake.setTable("contacts", [{ ...ex }]);
    vi.mocked(matchLeadIdentity).mockResolvedValue({
      recommendation: "link_existing",
      match: ex,
      normalizedPhone: PHONE,
      normalizedEmail: null,
    });

    const res = await withTenantContext(ORG, () =>
      createLead({
        fullName: "Ignorado",
        phone: PHONE,
        assignment: { mode: "explicit", advisorId: ADV },
        source: "manual",
        actorUserId: "user-1",
      }),
    );

    expect(res.contactCreated).toBe(false);
    expect(res.opportunityCreated).toBe(true);
    expect(res.assignedAdvisorId).toBe(ADV);
    // El contacto existente adoptó el asesor (no tenía).
    expect(fake.getTable("contacts")[0].assigned_advisor_id).toBe(ADV);
    expect(fake.getTable("opportunities")).toHaveLength(1);
  });

  it("caso 3: contacto con OPP ACTIVA en otra etapa → se respeta, no crea opp nueva ni roba asesor", async () => {
    const ex = existingContact({ id: "ex-3", assigned_advisor_id: "adv-owner" });
    fake.setTable("contacts", [{ ...ex }]);
    fake.setTable("opportunities", [
      {
        id: "opp-active",
        organization_id: ORG,
        contact_id: "ex-3",
        funnel: "venta",
        stage_id: "stage-cotizacion",
        cancelled_at: null,
      },
    ]);
    vi.mocked(matchLeadIdentity).mockResolvedValue({
      recommendation: "link_existing",
      match: ex,
      normalizedPhone: PHONE,
      normalizedEmail: null,
    });

    const res = await withTenantContext(ORG, () =>
      createLead({
        fullName: "Ignorado",
        phone: PHONE,
        assignment: { mode: "round_robin" },
        source: "webhook",
        inboundWebhookSourceId: "src-1",
      }),
    );

    expect(res.opportunityCreated).toBe(false);
    expect(res.skipReason).toBe("active_opportunity_exists");
    expect(res.contactCreated).toBe(false);
    // No se creó opp nueva (sigue habiendo 1).
    expect(fake.getTable("opportunities")).toHaveLength(1);
    // R2: no se robó el asesor dueño.
    expect(res.assignedAdvisorId).toBe("adv-owner");
    expect(fake.getTable("contacts")[0].assigned_advisor_id).toBe("adv-owner");
  });

  it("caso 4: lead SIN email ni dirección → se crea igual", async () => {
    vi.mocked(matchLeadIdentity).mockResolvedValue({
      recommendation: "create_new",
      match: null,
      normalizedPhone: PHONE,
      normalizedEmail: null,
    });

    const res = await withTenantContext(ORG, () =>
      createLead({
        fullName: "Solo Nombre",
        phone: PHONE,
        assignment: { mode: "explicit", advisorId: ADV },
        source: "manual",
        actorUserId: "user-1",
      }),
    );

    expect(res.contactCreated).toBe(true);
    const contact = fake.getTable("contacts")[0];
    expect(contact.email).toBeNull();
    expect(contact.address).toBeNull();
    expect(res.opportunityCreated).toBe(true);
  });

  it("caso 5: contacto ya en Whaapy → la asignación se refleja vía PATCH (update reason)", async () => {
    const ex = existingContact({ id: "ex-5", assigned_advisor_id: null, whaapy_contact_id: "wh-5" });
    fake.setTable("contacts", [{ ...ex }]);
    vi.mocked(matchLeadIdentity).mockResolvedValue({
      recommendation: "link_existing",
      match: ex,
      normalizedPhone: PHONE,
      normalizedEmail: null,
    });

    await withTenantContext(ORG, () =>
      createLead({
        fullName: "Ignorado",
        phone: PHONE,
        assignment: { mode: "explicit", advisorId: ADV },
        source: "manual",
        actorUserId: "user-1",
      }),
    );

    expect(recordWhaapySyncIntent).toHaveBeenCalledTimes(1);
    const [contactArg, reasonArg] = vi.mocked(recordWhaapySyncIntent).mock.calls[0];
    expect((contactArg as ContactRow).assigned_advisor_id).toBe(ADV);
    expect(reasonArg).toBe("update_from_platform_ui");
  });

  it("reparto round-robin: el asesor del pool se asigna a la opp", async () => {
    vi.mocked(pickRoundRobinAdvisor).mockResolvedValue({ advisorId: "adv-rr", poolSize: 3 });
    vi.mocked(matchLeadIdentity).mockResolvedValue({
      recommendation: "create_new",
      match: null,
      normalizedPhone: PHONE,
      normalizedEmail: null,
    });

    const res = await withTenantContext(ORG, () =>
      createLead({
        fullName: "Lead Web",
        phone: PHONE,
        assignment: { mode: "round_robin" },
        source: "webhook",
        inboundWebhookSourceId: "src-9",
      }),
    );

    expect(res.assignedAdvisorId).toBe("adv-rr");
    expect(fake.getTable("opportunities")[0].assigned_advisor_id).toBe("adv-rr");
    expect(fake.getTable("opportunities")[0].inbound_webhook_source_id).toBe("src-9");
  });

  it("rechaza teléfono inválido con LeadValidationError('invalid_phone')", async () => {
    vi.mocked(matchLeadIdentity).mockResolvedValue({
      recommendation: "create_new",
      match: null,
      normalizedPhone: null,
      normalizedEmail: null,
    });
    await expect(
      withTenantContext(ORG, () =>
        createLead({
          fullName: "X",
          phone: "bad",
          assignment: { mode: "explicit", advisorId: ADV },
          source: "manual",
        }),
      ),
    ).rejects.toBeInstanceOf(LeadValidationError);
  });

  it("rechaza asesor no elegible en creación manual", async () => {
    vi.mocked(matchLeadIdentity).mockResolvedValue({
      recommendation: "create_new",
      match: null,
      normalizedPhone: PHONE,
      normalizedEmail: null,
    });
    await expect(
      withTenantContext(ORG, () =>
        createLead({
          fullName: "X",
          phone: PHONE,
          assignment: { mode: "explicit", advisorId: "adv-que-no-existe" },
          source: "manual",
        }),
      ),
    ).rejects.toMatchObject({ code: "advisor_not_eligible" });
  });
});

describe("createLead — canal Outbound (Fase 2)", () => {
  it("contacto NUEVO: marca outbound + opp en funnel outbound SIN asignar", async () => {
    vi.mocked(matchLeadIdentity).mockResolvedValue({
      recommendation: "create_new",
      match: null,
      normalizedPhone: PHONE,
      normalizedEmail: null,
    });

    const res = await withTenantContext(ORG, () =>
      createLead({
        fullName: "Prospecto SDR",
        phone: PHONE,
        assignment: { mode: "explicit", advisorId: null },
        source: "manual",
        actorUserId: "sdr-1",
        channel: "outbound",
      }),
    );

    expect(res.opportunityCreated).toBe(true);
    const opps = fake.getTable("opportunities");
    expect(opps).toHaveLength(1);
    expect(opps[0].funnel).toBe("outbound");
    expect(opps[0].stage_id).toBe(OUTBOUND_STAGE);
    expect(opps[0].is_outbound).toBe(true);
    // El SDR no es asignable: la opp Outbound nace sin asesor.
    expect(opps[0].assigned_advisor_id).toBeNull();

    const contact = fake.getTable("contacts").find((c) => c.id === res.contactId);
    expect(contact?.is_outbound).toBe(true);
    const audit = fake.getTable("audit_log");
    expect(audit.some((a) => a.event_type === "contact_marked_outbound")).toBe(true);
  });

  it("contacto INBOUND existente: convierte y propaga SOLO a opps no terminales", async () => {
    const ex = existingContact({ id: "ex-2", assigned_advisor_id: ADV });
    fake.setTable("contacts", [{ ...ex }]);
    fake.setTable("opportunities", [
      {
        id: "opp-venta-activa",
        organization_id: ORG,
        funnel: "venta",
        contact_id: "ex-2",
        stage_id: INITIAL_STAGE,
        is_outbound: false,
        won_at: null,
        lost_at: null,
        cancelled_at: null,
        assigned_advisor_id: ADV,
      },
      {
        id: "opp-venta-ganada",
        organization_id: ORG,
        funnel: "venta",
        contact_id: "ex-2",
        stage_id: "won",
        is_outbound: false,
        won_at: "2026-01-01T00:00:00Z",
        lost_at: null,
        cancelled_at: null,
        assigned_advisor_id: ADV,
      },
    ]);
    vi.mocked(matchLeadIdentity).mockResolvedValue({
      recommendation: "link_existing",
      match: ex,
      normalizedPhone: PHONE,
      normalizedEmail: null,
    });

    await withTenantContext(ORG, () =>
      createLead({
        fullName: "Existente",
        phone: PHONE,
        assignment: { mode: "explicit", advisorId: null },
        source: "manual",
        actorUserId: "sdr-1",
        channel: "outbound",
      }),
    );

    const opps = fake.getTable("opportunities");
    // No terminal → hereda la marca; ganada → conserva su categoría (solo
    // activas y futuras).
    expect(opps.find((o) => o.id === "opp-venta-activa")?.is_outbound).toBe(true);
    expect(opps.find((o) => o.id === "opp-venta-ganada")?.is_outbound).toBe(false);
    // Contacto marcado outbound.
    expect(fake.getTable("contacts").find((c) => c.id === "ex-2")?.is_outbound).toBe(true);
    // Y nace una opp nueva en Outbound (el contacto no tenía opp Outbound activa).
    expect(opps.some((o) => o.funnel === "outbound" && o.is_outbound === true)).toBe(true);
  });
});

describe("createLead — mensaje del formulario de origen", () => {
  it("aterriza como nota de la opp nueva y como actividad `lead_message`", async () => {
    vi.mocked(matchLeadIdentity).mockResolvedValue({
      recommendation: "create_new",
      match: null,
      normalizedPhone: PHONE,
      normalizedEmail: null,
    });

    const res = await withTenantContext(ORG, () =>
      createLead({
        fullName: "Visitante Web",
        phone: PHONE,
        assignment: { mode: "round_robin" },
        source: "webhook",
        inboundWebhookSourceId: "src-1",
        message: "  Quiero cotizar una cocina integral  ",
        actorUserId: null,
      }),
    );

    const opps = fake.getTable("opportunities");
    expect(opps).toHaveLength(1);
    // Trim aplicado; el vendedor ve el contexto al abrir la card.
    expect(opps[0].note).toBe("Quiero cotizar una cocina integral");

    const activities = fake.getTable("activities");
    expect(activities).toHaveLength(1);
    expect(activities[0].activity_type).toBe("lead_message");
    expect(activities[0].description).toBe("Quiero cotizar una cocina integral");
    expect(activities[0].contact_id).toBe(res.contactId);
    expect(activities[0].opportunity_id).toBe(res.opportunityId);
  });

  it("registra la actividad AUNQUE se deduplique sin opp nueva (mensaje no se pierde)", async () => {
    const ex = existingContact({ id: "ex-msg", assigned_advisor_id: ADV });
    fake.setTable("contacts", [{ ...ex }]);
    fake.setTable("opportunities", [
      {
        id: "opp-active",
        organization_id: ORG,
        contact_id: "ex-msg",
        funnel: "venta",
        stage_id: "stage-cotizacion",
        won_at: null,
        lost_at: null,
        cancelled_at: null,
      },
    ]);
    vi.mocked(matchLeadIdentity).mockResolvedValue({
      recommendation: "link_existing",
      match: ex,
      normalizedPhone: PHONE,
      normalizedEmail: null,
    });

    const res = await withTenantContext(ORG, () =>
      createLead({
        fullName: "Visitante Web",
        phone: PHONE,
        assignment: { mode: "round_robin" },
        source: "webhook",
        inboundWebhookSourceId: "src-1",
        message: "Ya les había escrito, sigo esperando",
        actorUserId: null,
      }),
    );

    expect(res.opportunityCreated).toBe(false);
    expect(res.skipReason).toBe("active_opportunity_exists");

    const activities = fake.getTable("activities");
    expect(activities).toHaveLength(1);
    expect(activities[0].activity_type).toBe("lead_message");
    expect(activities[0].contact_id).toBe("ex-msg");
    expect(activities[0].opportunity_id).toBeNull();
  });

  it("sin mensaje (o solo espacios) no crea actividad ni ensucia la nota", async () => {
    vi.mocked(matchLeadIdentity).mockResolvedValue({
      recommendation: "create_new",
      match: null,
      normalizedPhone: PHONE,
      normalizedEmail: null,
    });

    await withTenantContext(ORG, () =>
      createLead({
        fullName: "Sin Mensaje",
        phone: PHONE,
        assignment: { mode: "round_robin" },
        source: "webhook",
        inboundWebhookSourceId: "src-1",
        message: "   ",
        actorUserId: null,
      }),
    );

    expect(fake.getTable("opportunities")[0].note).toBeNull();
    expect(fake.getTable("activities")).toHaveLength(0);
  });
});
