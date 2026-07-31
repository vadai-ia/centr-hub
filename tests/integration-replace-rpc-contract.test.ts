import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guard estático del RPC `replace_integration_connection` (0046).
 *
 * El reemplazo es la operación destructiva de la pantalla de Integraciones y
 * vive en SQL puro: ni `tsc` ni la suite mockeada ven dentro de plpgsql, así
 * que un `create or replace` futuro podría soltar un invariante en silencio.
 * Este test localiza la migración de MAYOR número que lo define y asierta que
 * su cuerpo los conserva.
 *
 *   INV-1 desenlace : suelta TODA identidad externa del proveedor.
 *   INV-2 historia  : NO borra filas de negocio (ningún DELETE).
 *   INV-3 vault     : limpia el bag de credenciales del proveedor.
 *   INV-4 atomicidad: SIN bloque EXCEPTION (rollback total ante cualquier fallo).
 *   INV-5 audit     : deja `integration_connection_replaced` con los conteos.
 *   INV-6 generación: sube `generation` y prefija los ids que no se pueden anular.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "supabase", "migrations");
const FN_SIGNATURE = "create or replace function public.replace_integration_connection";
const COUNT_FN_SIGNATURE = "create or replace function public.count_integration_linked_rows";

function findLatestMigration(signature: string): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  let latest: { file: string; sql: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    if (sql.toLowerCase().includes(signature)) latest = { file, sql };
  }
  if (!latest) throw new Error(`Ninguna migración define ${signature}`);
  return latest;
}

function extractBody(sql: string, signature: string): string {
  const lower = sql.toLowerCase();
  const start = lower.indexOf(signature);
  expect(start, `no se encontró el CREATE de ${signature}`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("$$;", start);
  expect(end, "no se encontró el cierre $$; del cuerpo").toBeGreaterThan(start);
  return sql.slice(start, end + 3);
}

describe("contrato SQL de replace_integration_connection (guard anti-regresión)", () => {
  const { file, sql } = findLatestMigration(FN_SIGNATURE);
  const body = extractBody(sql, FN_SIGNATURE);
  const lower = body.toLowerCase();

  it(`la definición vigente vive en ${file}`, () => {
    expect(file).toMatch(/^\d{4}_.*\.sql$/);
  });

  it("INV-1 desenlace Shopify: suelta shopify_customer_id, tags y refs de draft/orden", () => {
    expect(lower).toMatch(/shopify_customer_id\s*=\s*null/);
    expect(lower).toMatch(/shopify_tags\s*=\s*'\{\}'/);
    expect(lower).toMatch(/shopify_draft_order_id\s*=\s*null/);
  });

  it("INV-1 desenlace Whaapy Venta: suelta whaapy_contact_id y el mapeo de agentes", () => {
    expect(lower).toMatch(/whaapy_contact_id\s*=\s*null/);
    expect(lower).toMatch(/whaapy_agent_id\s*=\s*null/);
  });

  it("INV-2 historia: no borra NADA (sin DELETE sobre tablas de negocio)", () => {
    expect(lower, "el reemplazo desenlaza, nunca borra").not.toMatch(
      /delete\s+from\s+public\.(contacts|opportunities|orders|memberships)/,
    );
  });

  it("INV-3 vault: limpia el bag de credenciales de cada proveedor", () => {
    expect(lower).toContain("vault_keys - 'shopify'");
    expect(lower).toContain("vault_keys - 'whaapy'");
    expect(lower).toContain("vault_keys - 'whaapy_postventa'");
  });

  it("INV-4 atomicidad: sin bloque EXCEPTION (Postgres revierte todo si algo falla)", () => {
    expect(lower, "un EXCEPTION dejaría el reemplazo a medias").not.toMatch(
      /\bexception\s+when\b/,
    );
  });

  it("INV-5 audit: registra integration_connection_replaced con los conteos", () => {
    expect(lower).toContain("insert into public.audit_log");
    expect(body).toContain("integration_connection_replaced");
    expect(lower).toContain("'unlinked'");
  });

  it("INV-6 generación: sube generation y prefija los ids no anulables", () => {
    expect(lower).toMatch(/v_generation\s*:=\s*v_generation\s*\+\s*1/);
    expect(lower).toContain("'unlinked:g'");
    // orders.shopify_order_id es NOT NULL + UNIQUE → se prefija, no se anula.
    expect(lower).toMatch(/shopify_order_id\s*=\s*v_prefix\s*\|\|/);
  });

  it("el dry-run comparte función con el desenlace (no puede divergir del efecto real)", () => {
    expect(lower).toContain("public.count_integration_linked_rows");
  });
});

describe("contrato SQL de count_integration_linked_rows (dry-run)", () => {
  const { sql } = findLatestMigration(COUNT_FN_SIGNATURE);
  const body = extractBody(sql, COUNT_FN_SIGNATURE);
  const lower = body.toLowerCase();

  it("es READ-ONLY: declarado STABLE y sin ninguna escritura", () => {
    expect(lower).toContain("stable");
    expect(lower).not.toMatch(/\b(update|insert|delete)\s+/);
  });

  it("cuenta las mismas identidades externas que el desenlace suelta", () => {
    expect(lower).toContain("shopify_customer_id is not null");
    expect(lower).toContain("whaapy_contact_id is not null");
    expect(lower).toContain("whaapy_agent_id is not null");
  });

  it("ignora los pedidos ya desenlazados (idempotencia entre reemplazos)", () => {
    expect(lower).toContain("not like 'unlinked:g%'");
  });
});
