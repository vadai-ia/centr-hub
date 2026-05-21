import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

import { withTenantContext } from "@/lib/tenant/context";
import { parseShopifyTags } from "@/lib/services/tag-parser";

const ORG = "org-1";

beforeEach(() => {
  fake.reset();
});

function seedVendorTag(opts: {
  normalized: string;
  original: string;
  membershipId: string;
}) {
  fake.setTable("tag_mappings", [
    ...fake.getTable("tag_mappings"),
    {
      id: `tm-${opts.normalized}`,
      organization_id: ORG,
      normalized_tag: opts.normalized,
      original_tag: opts.original,
      classification: "vendor",
      mapped_membership_id: opts.membershipId,
      created_by_user_id: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ]);
}

function seedInfoTag(opts: { normalized: string; original: string }) {
  fake.setTable("tag_mappings", [
    ...fake.getTable("tag_mappings"),
    {
      id: `tm-${opts.normalized}`,
      organization_id: ORG,
      normalized_tag: opts.normalized,
      original_tag: opts.original,
      classification: "informational",
      mapped_membership_id: null,
      created_by_user_id: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ]);
}

function seedMembership(opts: { id: string; isActive: boolean }) {
  fake.setTable("memberships", [
    ...fake.getTable("memberships"),
    {
      id: opts.id,
      organization_id: ORG,
      user_id: `u-${opts.id}`,
      role: "vendedor",
      is_active: opts.isActive,
      whaapy_agent_id: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ]);
}

describe("parser de tags — 6 edge cases (Sección 3.3.10 R2 + CLAUDE.md)", () => {
  it("caso 1 — CSV + normalización: separa, trimea, lowercase para match", async () => {
    seedVendorTag({ normalized: "ginajiménez", original: "GinaJiménez", membershipId: "m-gina" });
    seedMembership({ id: "m-gina", isActive: true });

    await withTenantContext(ORG, async () => {
      const result = await parseShopifyTags({
        rawTags: "  GinaJiménez , FACTURADA  ",
        source: "customer",
      });
      expect(result.normalizedTagList).toEqual(["ginajiménez", "facturada"]);
      // Auto-creó 'facturada' como informational (caso 3)
      expect(result.informationalTags).toHaveLength(1);
      expect(result.informationalTags[0].normalized).toBe("facturada");
      // Vendor: Gina asignada
      expect(result.assignedMembership?.id).toBe("m-gina");
      expect(result.multipleVendorTagsDetected).toBe(false);
    });
  });

  it("caso 2 — tag vendor activa: asigna asesor", async () => {
    seedVendorTag({ normalized: "carlos", original: "Carlos", membershipId: "m-carlos" });
    seedMembership({ id: "m-carlos", isActive: true });

    await withTenantContext(ORG, async () => {
      const result = await parseShopifyTags({ rawTags: ["Carlos"], source: "order" });
      expect(result.assignedMembership?.id).toBe("m-carlos");
      expect(result.vendorIsInactive).toBe(false);
    });
  });

  it("caso 3 — tag informativa o sin clasificar: conservada, sin atribución, sin alerta", async () => {
    seedInfoTag({ normalized: "factura", original: "Factura" });

    await withTenantContext(ORG, async () => {
      const result = await parseShopifyTags({
        rawTags: ["Factura", "TagNuevaSinClasificar"],
        source: "draft_order",
      });
      // Las dos quedan informativas
      expect(result.informationalTags).toHaveLength(2);
      expect(result.vendorTags).toHaveLength(0);
      expect(result.assignedMembership).toBe(null);
      expect(result.multipleVendorTagsDetected).toBe(false);
      // No hay alerta — no se busca en audit log
      const auditEvents = fake.getTable("audit_log");
      expect(
        auditEvents.find((e) => e.event_type === "multiple_advisor_tags_anomaly"),
      ).toBeUndefined();
    });
  });

  it("caso 4 — múltiples tags vendor: NULL + multipleVendorTagsDetected + audit log", async () => {
    seedVendorTag({ normalized: "gina", original: "Gina", membershipId: "m-gina" });
    seedVendorTag({ normalized: "carlos", original: "Carlos", membershipId: "m-carlos" });
    seedMembership({ id: "m-gina", isActive: true });
    seedMembership({ id: "m-carlos", isActive: true });

    await withTenantContext(ORG, async () => {
      const result = await parseShopifyTags({
        rawTags: ["Gina", "Carlos"],
        source: "draft_order",
        shopifyEntityId: "do-999",
      });
      expect(result.multipleVendorTagsDetected).toBe(true);
      expect(result.assignedMembership).toBe(null);
      const auditEvents = fake.getTable("audit_log");
      const anomaly = auditEvents.find(
        (e) => e.event_type === "multiple_advisor_tags_anomaly",
      );
      expect(anomaly).toBeDefined();
      expect((anomaly as { payload: { vendor_tags: string[] } }).payload.vendor_tags)
        .toEqual(expect.arrayContaining(["gina", "carlos"]));
    });
  });

  it("caso 5 — vendedor desactivado: NULL + audit tag_mapped_to_inactive_vendor", async () => {
    seedVendorTag({ normalized: "rosa", original: "Rosa", membershipId: "m-rosa" });
    seedMembership({ id: "m-rosa", isActive: false });

    await withTenantContext(ORG, async () => {
      const result = await parseShopifyTags({
        rawTags: ["Rosa"],
        source: "customer",
      });
      expect(result.assignedMembership).toBe(null);
      expect(result.vendorIsInactive).toBe(true);
      const auditEvents = fake.getTable("audit_log");
      expect(
        auditEvents.find((e) => e.event_type === "tag_mapped_to_inactive_vendor"),
      ).toBeDefined();
    });
  });

  it("caso 6 — defensa contra mapeo ambiguo: UNIQUE constraint del schema previene; el parser no asume duplicados", async () => {
    seedVendorTag({ normalized: "tony", original: "Tony", membershipId: "m-tony" });
    seedMembership({ id: "m-tony", isActive: true });
    // No agregamos un segundo mapping con la misma normalized_tag — el UNIQUE
    // constraint impediría llegar aquí. El test valida que el parser opera
    // correctamente con el flujo "happy path" cuando el invariante se cumple.
    await withTenantContext(ORG, async () => {
      const result = await parseShopifyTags({ rawTags: ["Tony"], source: "order" });
      expect(result.assignedMembership?.id).toBe("m-tony");
    });
  });

  it("auto-creación de tags desconocidas como informational (O4)", async () => {
    await withTenantContext(ORG, async () => {
      await parseShopifyTags({ rawTags: ["TagNueva"], source: "customer" });
      const newRow = fake
        .getTable("tag_mappings")
        .find((r) => r.normalized_tag === "tagnueva");
      expect(newRow).toBeDefined();
      expect((newRow as { classification: string }).classification).toBe("informational");
    });
  });
});
