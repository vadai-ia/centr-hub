import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guard estático anti-regresión del RPC de handoff Outbound → Venta.
 *
 * `handoff_outbound_opportunity` es el PRIMER movimiento cross-funnel in-place
 * del sistema. Un `create or replace` futuro que suelte cualquiera de sus
 * invariantes es una regresión silenciosa (el RPC es SQL puro; ni tsc ni la
 * suite mockeada lo ven). Este test localiza la migración de MAYOR número que
 * lo define y asierta que su cuerpo conserva las invariantes.
 *
 *   INV-1 flip, no hija — es un UPDATE de la MISMA fila, NO un INSERT into
 *          opportunities (a diferencia de trigger_f1_to_f2, que crea hija).
 *   INV-2 marca       — NO toca is_outbound (la marca permanente sobrevive).
 *   INV-3 asesor      — setea assigned_advisor_id = p_advisor_membership_id.
 *   INV-4 destino     — resuelve la etapa Venta "Contacto calificado".
 *   INV-5 guard       — valida funnel='outbound' (idempotencia / no reuso).
 *   INV-6 contacto    — asigna el vendedor al CONTACTO (contacts.assigned_
 *                       advisor_id) en la misma transacción (dispara Whaapy/
 *                       Shopify/data-scope).
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "supabase", "migrations");
const FN_SIGNATURE = "create or replace function public.handoff_outbound_opportunity";

function findLatestMigration(): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  let latest: { file: string; sql: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    if (sql.toLowerCase().includes(FN_SIGNATURE)) latest = { file, sql };
  }
  if (!latest) throw new Error(`Ninguna migración define ${FN_SIGNATURE}`);
  return latest;
}

function extractBody(sql: string): string {
  const lower = sql.toLowerCase();
  const start = lower.indexOf(FN_SIGNATURE);
  expect(start, "no se encontró el CREATE del RPC").toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("$$;", start);
  expect(end, "no se encontró el cierre $$; del cuerpo").toBeGreaterThan(start);
  return sql.slice(start, end + 3);
}

describe("contrato SQL del RPC handoff Outbound→Venta (guard anti-regresión)", () => {
  const { file, sql } = findLatestMigration();
  const body = extractBody(sql);
  const lower = body.toLowerCase();

  it(`la definición vigente vive en ${file}`, () => {
    expect(file).toMatch(/^\d{4}_.*\.sql$/);
  });

  it("INV-1 flip, no hija: es un UPDATE de la misma fila, NO un INSERT into opportunities", () => {
    expect(lower, "INV-1: no debe crear una fila nueva (INSERT into opportunities)").not.toContain(
      "insert into public.opportunities",
    );
    expect(lower, "INV-1: debe actualizar la fila existente").toMatch(
      /update\s+public\.opportunities/,
    );
  });

  it("INV-2 marca: NO toca is_outbound (la marca permanente sobrevive el flip)", () => {
    expect(lower, "INV-2: el RPC no debe mencionar is_outbound").not.toContain("is_outbound");
  });

  it("INV-3 asesor: setea assigned_advisor_id = p_advisor_membership_id", () => {
    expect(lower).toMatch(/assigned_advisor_id\s*=\s*p_advisor_membership_id/);
  });

  it("INV-4 destino: resuelve la etapa Venta 'Contacto calificado' y flipea a venta", () => {
    expect(body, "INV-4: destino canónico").toContain("Contacto calificado");
    expect(lower, "INV-4: flip a funnel venta").toMatch(/funnel\s*=\s*'venta'/);
  });

  it("INV-5 guard: valida funnel='outbound' (idempotencia)", () => {
    expect(lower).toMatch(/funnel\s*<>\s*'outbound'/);
  });

  it("INV-6 contacto: asigna el vendedor al contacto (contacts.assigned_advisor_id)", () => {
    expect(lower, "INV-6: el handoff debe actualizar public.contacts").toMatch(
      /update\s+public\.contacts/,
    );
    // El UPDATE de contacts debe setear el asesor al vendedor de la entrega.
    const at = lower.indexOf("update public.contacts");
    expect(at, "INV-6: no se encontró el UPDATE de contacts").toBeGreaterThan(0);
    const block = lower.slice(at, at + 300);
    expect(block, "INV-6: el contacto no adopta p_advisor_membership_id").toMatch(
      /assigned_advisor_id\s*=\s*p_advisor_membership_id/,
    );
  });
});
