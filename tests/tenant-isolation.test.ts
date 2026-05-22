import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests de aislamiento multi-tenant (Sección 3.7 + R6).
 *
 * Estrategia: mockear `@/lib/supabase/admin` con un fake client
 * que registra todos los filtros `eq()` aplicados sobre cada
 * query. Después ejecutamos el data layer bajo dos organizaciones
 * distintas y validamos que TODA query lleva el `organization_id`
 * correcto.
 *
 * Esto valida la Barrera 2 (wrapper de tenant en aplicación), que
 * es la barrera que sigue siendo efectiva incluso con service_role
 * — y es la que cubrió el bug de Hemenesy.
 */

interface Filter {
  field: string;
  op: "eq" | "is" | "or";
  value: unknown;
}

interface RecordedQuery {
  table: string;
  action: "select" | "insert" | "update" | "delete" | "upsert";
  filters: Filter[];
  insertPayload?: unknown;
  updatePayload?: unknown;
}

const recorded: RecordedQuery[] = [];

function makeBuilder(table: string, action: RecordedQuery["action"]) {
  const q: RecordedQuery = { table, action, filters: [] };
  recorded.push(q);

  const builder: {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    is: ReturnType<typeof vi.fn>;
    or: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    range: ReturnType<typeof vi.fn>;
    gte: ReturnType<typeof vi.fn>;
    lte: ReturnType<typeof vi.fn>;
    maybeSingle: ReturnType<typeof vi.fn>;
    single: ReturnType<typeof vi.fn>;
    then: (resolve: (v: { data: unknown[]; error: null }) => void) => void;
  } = {
    select: vi.fn().mockImplementation(() => builder),
    eq: vi.fn().mockImplementation((field: string, value: unknown) => {
      q.filters.push({ field, op: "eq", value });
      return builder;
    }),
    is: vi.fn().mockImplementation((field: string, value: unknown) => {
      q.filters.push({ field, op: "is", value });
      return builder;
    }),
    or: vi.fn().mockImplementation((expr: string) => {
      q.filters.push({ field: "<or>", op: "or", value: expr });
      return builder;
    }),
    order: vi.fn().mockImplementation(() => builder),
    limit: vi.fn().mockImplementation(() => builder),
    range: vi.fn().mockImplementation(() => builder),
    gte: vi.fn().mockImplementation(() => builder),
    lte: vi.fn().mockImplementation(() => builder),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    single: vi.fn().mockResolvedValue({
      data: action === "insert" || action === "update"
        ? { id: "fake-id" }
        : null,
      error: null,
    }),
    // permitir await directo (devuelve {data:[], error:null})
    then(resolve) {
      resolve({ data: [], error: null });
    },
  };

  // insert/update/upsert capturan payload
  return builder;
}

const supabaseMock = {
  from(table: string) {
    return {
      select: vi.fn().mockImplementation(() => makeBuilder(table, "select")),
      insert: vi.fn().mockImplementation((payload: unknown) => {
        const b = makeBuilder(table, "insert");
        b.eq.mockClear();
        const q = recorded[recorded.length - 1];
        q.insertPayload = payload;
        return b;
      }),
      update: vi.fn().mockImplementation((payload: unknown) => {
        const b = makeBuilder(table, "update");
        const q = recorded[recorded.length - 1];
        q.updatePayload = payload;
        return b;
      }),
      delete: vi.fn().mockImplementation(() => makeBuilder(table, "delete")),
      upsert: vi.fn().mockImplementation((payload: unknown) => {
        const b = makeBuilder(table, "upsert");
        const q = recorded[recorded.length - 1];
        q.insertPayload = payload;
        return b;
      }),
    };
  },
  rpc: vi.fn().mockResolvedValue({ data: "fake-id", error: null }),
};

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => supabaseMock,
}));

// Imports DESPUÉS del vi.mock para que el data layer use el fake.
import { withTenantContext, TenantContextRequiredError } from "@/lib/tenant/context";
import * as contactsDb from "@/lib/db/contacts";
import * as pipelineDb from "@/lib/db/pipeline";
import * as ordersDb from "@/lib/db/orders";
import * as operationalDb from "@/lib/db/operational";
import * as automationDb from "@/lib/db/automation";
import * as usersDb from "@/lib/db/users";
import * as configurationDb from "@/lib/db/configuration";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

function eqFilterValue(q: RecordedQuery, field: string): unknown {
  return q.filters.find((f) => f.field === field && f.op === "eq")?.value;
}

beforeEach(() => {
  recorded.length = 0;
});

describe("aislamiento multi-tenant — Barrera 2", () => {
  it("data layer lanza si se llama fuera del wrapper de tenant", async () => {
    await expect(contactsDb.listContacts({ limit: 5 })).rejects.toThrowError(
      TenantContextRequiredError,
    );
    await expect(pipelineDb.listPipelineStages("venta")).rejects.toThrowError(
      TenantContextRequiredError,
    );
    await expect(operationalDb.listAuditEvents()).rejects.toThrowError(
      TenantContextRequiredError,
    );
  });

  it("listContacts filtra por organization_id dentro del wrapper", async () => {
    await withTenantContext(
      ORG_A,
      async () => {
        await contactsDb.listContacts({ limit: 10 });
      },
      { source: "test" },
    );

    expect(recorded).toHaveLength(1);
    const q = recorded[0];
    expect(q.table).toBe("contacts");
    expect(eqFilterValue(q, "organization_id")).toBe(ORG_A);
  });

  it("createContact inyecta organization_id en el insert", async () => {
    await withTenantContext(
      ORG_A,
      async () => {
        await contactsDb.createContact({
          full_name: "Alice",
          email: "alice@example.com",
          phone: "+525555555555",
          address: null,
          internal_note: null,
          shopify_tags: [],
          shopify_state: null,
          assigned_advisor_id: null,
          shopify_customer_id: null,
          whaapy_contact_id: null,
          field_metadata: {},
          last_modified_at: new Date().toISOString(),
          last_modified_source: "platform",
          missing_phone: false,
          deleted_in_shopify: false,
          deleted_in_whaapy: false,
          anonymized_at: null,
          last_whaapy_activity_at: null,
        });
      },
      { source: "test" },
    );

    const insertQuery = recorded.find((q) => q.action === "insert");
    expect(insertQuery).toBeDefined();
    expect(
      (insertQuery!.insertPayload as { organization_id: string }).organization_id,
    ).toBe(ORG_A);
  });

  it("updateContact filtra por organization_id Y por id", async () => {
    await withTenantContext(
      ORG_A,
      async () => {
        await contactsDb.updateContact("contact-1", { full_name: "Renamed" });
      },
      { source: "test" },
    );

    const q = recorded.find((r) => r.action === "update");
    expect(q).toBeDefined();
    expect(eqFilterValue(q!, "organization_id")).toBe(ORG_A);
    expect(eqFilterValue(q!, "id")).toBe("contact-1");
  });

  it("listPipelineStages filtra por organization_id Y funnel cuando se pasa", async () => {
    await withTenantContext(
      ORG_B,
      async () => {
        await pipelineDb.listPipelineStages("post_venta");
      },
      { source: "test" },
    );

    const q = recorded[0];
    expect(eqFilterValue(q, "organization_id")).toBe(ORG_B);
    expect(eqFilterValue(q, "funnel")).toBe("post_venta");
  });

  it("órganizaciones distintas → queries con filtros distintos (no cross-contamination)", async () => {
    await withTenantContext(ORG_A, async () => {
      await contactsDb.listContacts();
      await pipelineDb.listPipelineStages();
      await ordersDb.findOrderByShopifyOrderId("12345");
    }, { source: "test" });

    await withTenantContext(ORG_B, async () => {
      await contactsDb.listContacts();
      await pipelineDb.listPipelineStages();
      await ordersDb.findOrderByShopifyOrderId("12345");
    }, { source: "test" });

    const orgAQueries = recorded.slice(0, 3);
    const orgBQueries = recorded.slice(3);

    orgAQueries.forEach((q) => {
      expect(eqFilterValue(q, "organization_id")).toBe(ORG_A);
    });
    orgBQueries.forEach((q) => {
      expect(eqFilterValue(q, "organization_id")).toBe(ORG_B);
    });
  });

  it("findContactByShopifyCustomerId filtra por organization_id", async () => {
    await withTenantContext(ORG_A, async () => {
      await contactsDb.findContactByShopifyCustomerId("shopify-cid-1");
    });

    const q = recorded[0];
    expect(eqFilterValue(q, "organization_id")).toBe(ORG_A);
    expect(eqFilterValue(q, "shopify_customer_id")).toBe("shopify-cid-1");
  });

  it("recordAuditEvent inyecta organization_id en el insert", async () => {
    await withTenantContext(ORG_A, async () => {
      await operationalDb.recordAuditEvent({
        eventType: "sync_loop_prevented",
        payload: { reason: "centrhub marker detected" },
      });
    });

    const q = recorded.find((r) => r.action === "insert");
    expect(q).toBeDefined();
    expect(
      (q!.insertPayload as { organization_id: string }).organization_id,
    ).toBe(ORG_A);
  });

  it("recordActivity exige contactId u opportunityId — no permite ambos nulos", async () => {
    await withTenantContext(ORG_A, async () => {
      await expect(
        operationalDb.recordActivity({
          activityType: "note",
          description: "test",
        }),
      ).rejects.toThrowError(/contactId u opportunityId/);
    });
  });

  it("automationDb.recordRuleExecution inyecta organization_id", async () => {
    await withTenantContext(ORG_B, async () => {
      await automationDb.recordRuleExecution({
        ruleId: "rule-1",
        status: "success",
      });
    });

    const q = recorded.find((r) => r.action === "insert");
    expect(q).toBeDefined();
    expect(
      (q!.insertPayload as { organization_id: string }).organization_id,
    ).toBe(ORG_B);
  });

  it("usersDb funciones cross-org NO requieren tenant context (es admin scope)", async () => {
    // usersDb.getUserProfile, listMembershipsForUser, etc. operan
    // sobre datos que cruzan organizaciones (un usuario pertenece
    // a N orgs). Aún así están en admin scope; el guardia real es
    // el caller. Validamos que no truenen con TenantContextRequiredError.
    await expect(usersDb.getUserProfile("u1")).resolves.not.toThrow();
    await expect(usersDb.listMembershipsForUser("u1")).resolves.not.toThrow();
  });

  it("configuration: upsertTagMapping filtra por organization_id en onConflict", async () => {
    await withTenantContext(ORG_A, async () => {
      await configurationDb.upsertTagMapping({
        normalized_tag: "vip",
        original_tag: "VIP",
        classification: "informational",
        mapped_membership_id: null,
        created_by_user_id: null,
      });
    });

    const q = recorded.find((r) => r.action === "upsert");
    expect(q).toBeDefined();
    expect(
      (q!.insertPayload as { organization_id: string }).organization_id,
    ).toBe(ORG_A);
  });
});
