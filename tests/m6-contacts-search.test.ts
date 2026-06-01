import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./helpers/fake-supabase";

/**
 * Búsqueda paginada de contactos (M6 — B1).
 *
 * Verifica:
 *   - Deriva contactType desde shopify_customer_id (O12).
 *   - hasMore=true cuando la fuente devuelve > limit filas.
 *   - hasMore=false cuando la fuente devuelve <= limit filas.
 *   - Filtro por vendedor (assignedAdvisorId) genera el .eq correcto.
 *   - Filtro "Sin asignar" (assignedAdvisorId=null) genera .is null.
 *   - Sin query devuelve filas sin construir predicados or.
 *
 * Nota: el FakeSupabase NO aplica `.or()` ni `.range()` realmente, así
 * que estos tests cubren la forma del shape y el wiring de filtros eq/is,
 * no el comportamiento del LIKE en PostgreSQL. La validación real del
 * LIKE queda para el smoke E2E del CHECKPOINT.
 */

const fake = new FakeSupabase();
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => fake,
}));

import { withTenantContext } from "@/lib/tenant/context";
import { searchContactsForList } from "@/lib/db/contacts";

const ORG = "org-1";

function seedContacts(count: number, opts: { advisorId?: string | null } = {}) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `c-${i}`,
    organization_id: ORG,
    full_name: `Contacto ${i}`,
    email: `c${i}@example.com`,
    phone: `+521555000${i.toString().padStart(4, "0")}`,
    shopify_customer_id: i % 2 === 0 ? `sc-${i}` : null,
    whaapy_contact_id: i % 3 === 0 ? `wc-${i}` : null,
    assigned_advisor_id: opts.advisorId === undefined ? `m-${i % 2}` : opts.advisorId,
    last_modified_at: new Date(2026, 0, 1 + i).toISOString(),
    last_whaapy_activity_at: null,
    missing_phone: false,
    deleted_in_shopify: false,
    deleted_in_whaapy: false,
    anonymized_at: null,
  }));
  fake.setTable("contacts", rows);
}

beforeEach(() => {
  fake.reset();
});

describe("searchContactsForList", () => {
  it("deriva contactType desde shopify_customer_id", async () => {
    seedContacts(2);
    const result = await withTenantContext(ORG, async () => {
      return searchContactsForList({ limit: 50 });
    });
    expect(result.rows).toHaveLength(2);
    const withShopify = result.rows.find((r) => r.id === "c-0");
    const withoutShopify = result.rows.find((r) => r.id === "c-1");
    expect(withShopify?.contactType).toBe("cliente");
    expect(withoutShopify?.contactType).toBe("lead");
  });

  it("hasMore=true cuando hay más filas que limit", async () => {
    seedContacts(6);
    const result = await withTenantContext(ORG, async () => {
      // El fake no respeta range() — devuelve todas las filas que
      // pasen los filtros .eq. Como pedimos `limit + 1` al cliente,
      // recibimos 6 > 5 → hasMore true, slice a 5.
      return searchContactsForList({ limit: 5 });
    });
    expect(result.hasMore).toBe(true);
    expect(result.rows).toHaveLength(5);
  });

  it("hasMore=false cuando hay exactamente limit filas", async () => {
    seedContacts(3);
    const result = await withTenantContext(ORG, async () => {
      return searchContactsForList({ limit: 5 });
    });
    expect(result.hasMore).toBe(false);
    expect(result.rows).toHaveLength(3);
  });

  it("filtro por advisor genera .eq sobre assigned_advisor_id", async () => {
    seedContacts(4);
    await withTenantContext(ORG, async () => {
      await searchContactsForList({ limit: 10, assignedAdvisorId: "m-1" });
    });
    const lastSelect = fake.history.at(-1);
    const eqAdvisor = lastSelect?.filters.find(
      (f) => f.field === "assigned_advisor_id" && f.op === "eq",
    );
    expect(eqAdvisor?.value).toBe("m-1");
  });

  it("filtro 'Sin asignar' genera .is null sobre assigned_advisor_id", async () => {
    seedContacts(4);
    await withTenantContext(ORG, async () => {
      await searchContactsForList({ limit: 10, assignedAdvisorId: null });
    });
    const lastSelect = fake.history.at(-1);
    const isAdvisor = lastSelect?.filters.find(
      (f) => f.field === "assigned_advisor_id" && f.op === "is",
    );
    expect(isAdvisor).toBeDefined();
    expect(isAdvisor?.value).toBeNull();
  });

  it("sin advisorId no agrega filtro de advisor (admin sin filtro)", async () => {
    seedContacts(2);
    await withTenantContext(ORG, async () => {
      await searchContactsForList({ limit: 10 });
    });
    const lastSelect = fake.history.at(-1);
    const advisorFilters = lastSelect?.filters.filter(
      (f) => f.field === "assigned_advisor_id",
    );
    expect(advisorFilters?.length ?? 0).toBe(0);
  });

  it("query con texto genera predicados .or", async () => {
    seedContacts(2);
    await withTenantContext(ORG, async () => {
      await searchContactsForList({ limit: 10, query: "Regina" });
    });
    const lastSelect = fake.history.at(-1);
    const orFilter = lastSelect?.filters.find((f) => f.op === "or");
    expect(orFilter).toBeDefined();
    const expr = orFilter?.value as string;
    expect(expr).toContain("full_name.ilike");
    expect(expr).toContain("email.ilike");
    expect(expr).toContain("phone.ilike");
  });

  it("query con caracteres especiales se sanitiza antes del .or", async () => {
    seedContacts(2);
    await withTenantContext(ORG, async () => {
      await searchContactsForList({
        limit: 10,
        // estos caracteres romperían el parser de PostgREST .or
        query: "Re,gina(test).val%ue",
      });
    });
    const lastSelect = fake.history.at(-1);
    const orFilter = lastSelect?.filters.find((f) => f.op === "or");
    const expr = orFilter?.value as string;
    // El chain SÍ usa "," como separador de predicados (sintaxis
    // PostgREST). Lo crítico es que los VALORES interpolados entre
    // `%...%` no contengan los caracteres que romperían el parser.
    const valueRegex = /%([^%]*)%/g;
    let match: RegExpExecArray | null;
    while ((match = valueRegex.exec(expr)) !== null) {
      const value = match[1];
      // Caracteres prohibidos dentro de un valor del .or
      expect(value).not.toMatch(/[,()%.]/);
    }
  });

  it("query vacía no agrega predicado or", async () => {
    seedContacts(2);
    await withTenantContext(ORG, async () => {
      await searchContactsForList({ limit: 10, query: "   " });
    });
    const lastSelect = fake.history.at(-1);
    const orFilter = lastSelect?.filters.find((f) => f.op === "or");
    expect(orFilter).toBeUndefined();
  });
});
