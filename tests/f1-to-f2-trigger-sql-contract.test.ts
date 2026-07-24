import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guard estático anti-regresión del trigger F1→F2.
 *
 * CONTEXTO: `trigger_f1_to_f2` se redefine con `create or replace` en
 * varias migraciones (0020 base, 0021 datos comerciales, 0022 asesor,
 * 0025 fecha real, 0027 consolidación). `create or replace` reemplaza el
 * CUERPO ENTERO — no es un parche. La migración 0025 se rebasó sobre
 * 0020 y BORRÓ silenciosamente la herencia comercial de 0021 (la hija de
 * Post-venta volvió a nacer pelada). Ni `tsc` ni la suite mockeada
 * cazaron eso porque el trigger es SQL puro en la BD.
 *
 * ESTE TEST cierra ese agujero SIN infra nueva (no levanta Postgres):
 * localiza la migración de MAYOR número que redefine el trigger (la
 * definición vigente) y asierta que su cuerpo contiene las cuatro
 * invariantes acumuladas. Si una migración futura re-CREATE el trigger y
 * suelta cualquiera, este test falla en CI — auto-rastrea la última
 * definición, no hay puntero que mantener a mano.
 *
 * Las cuatro invariantes (ver cabezal de 0027):
 *   INV-1 comercial   — el INSERT de la hija incluye actual_amount,
 *                       estimated_amount, shopify_order_id, display_reference.
 *   INV-2 line items  — INSERT-SELECT de opportunity_line_items F1 → hija.
 *   INV-3 asesor      — asesor de la hija = coalesce(asesor_orden, F1).
 *   INV-4 fecha real  — won_at / shopify_event_at desde orders.shopify_created_at.
 *   INV-5 outbound    — la hija hereda is_outbound de la F1 (marca 0040 que
 *                       recorre todo el ciclo de vida de la oportunidad).
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "supabase", "migrations");
const FN_SIGNATURE = "create or replace function public.trigger_f1_to_f2";

/** Migración de mayor número (prefijo NNNN_) que redefine el trigger. */
function findLatestTriggerMigration(): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort(); // orden lexicográfico = orden numérico (prefijo de ancho fijo)

  let latest: { file: string; sql: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    if (sql.toLowerCase().includes(FN_SIGNATURE)) {
      latest = { file, sql }; // el último que matchea en orden = el de mayor número
    }
  }
  if (!latest) {
    throw new Error(
      `Ninguna migración define ${FN_SIGNATURE} — ¿se renombró el trigger?`,
    );
  }
  return latest;
}

/**
 * Aísla el cuerpo de la función trigger_f1_to_f2 (desde su CREATE hasta
 * el cierre `$$;`) para que las aserciones no matcheen otras funciones
 * que la misma migración pudiera definir (ej. correctivos).
 */
function extractTriggerBody(sql: string): string {
  const lower = sql.toLowerCase();
  const start = lower.indexOf(FN_SIGNATURE);
  expect(start, "no se encontró el CREATE del trigger en la migración").toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("$$;", start);
  expect(end, "no se encontró el cierre $$; del cuerpo del trigger").toBeGreaterThan(start);
  return sql.slice(start, end + 3).toLowerCase();
}

describe("contrato SQL del trigger F1→F2 (guard anti-regresión)", () => {
  const { file, sql } = findLatestTriggerMigration();
  const body = extractTriggerBody(sql);

  it(`la definición vigente vive en ${file}`, () => {
    // Ancla informativa: deja en el output qué migración se está validando.
    expect(file).toMatch(/^\d{4}_.*\.sql$/);
  });

  it("INV-1 comercial: la hija hereda actual_amount, estimated_amount, shopify_order_id, display_reference", () => {
    // El INSERT de la hija debe nombrar las cuatro columnas comerciales.
    // Aislamos el INSERT into opportunities de la hija (el que setea funnel
    // post_venta vía parent) buscando el bloque que las lista juntas.
    for (const col of [
      "actual_amount",
      "estimated_amount",
      "shopify_order_id",
      "display_reference",
    ]) {
      expect(body, `INV-1: falta la columna "${col}" en el cuerpo del trigger`).toContain(col);
    }
    // Defensa adicional: el INSERT de la hija (post_venta) debe listar las
    // columnas comerciales en su tupla de columnas, no solo mencionarlas.
    expect(
      body,
      "INV-1: el INSERT de la hija no incluye las columnas comerciales en su lista",
    ).toMatch(
      /actual_amount,\s*estimated_amount,\s*shopify_order_id,\s*display_reference/,
    );
  });

  it("INV-2 line items: hay un INSERT-SELECT de opportunity_line_items de la F1 a la hija", () => {
    expect(
      body,
      "INV-2: falta el INSERT into opportunity_line_items",
    ).toContain("insert into public.opportunity_line_items");
    // Debe ser un INSERT ... SELECT (copia), no un INSERT ... VALUES.
    const liStart = body.indexOf("insert into public.opportunity_line_items");
    const after = body.slice(liStart, liStart + 600);
    expect(after, "INV-2: el INSERT de line items no es un INSERT-SELECT").toContain("select");
    expect(after, "INV-2: el INSERT-SELECT no copia desde opportunity_line_items").toContain(
      "from public.opportunity_line_items",
    );
  });

  it("INV-3 asesor: la hija nace con coalesce(asesor_orden, asesor_F1), no con el asesor de la F1 directo", () => {
    // Debe resolver el asesor de la orden y combinarlo con el de la F1.
    expect(
      body,
      "INV-3: no se resuelve el asesor de la orden (select assigned_advisor_id ... from public.orders)",
    ).toMatch(/select\s+assigned_advisor_id\s+into[\s\S]*?from\s+public\.orders/);
    expect(
      body,
      "INV-3: el asesor de la hija no es coalesce(asesor_orden, asesor_F1)",
    ).toMatch(/coalesce\([\s\S]*?v_f1\.assigned_advisor_id\)/);
  });

  it("INV-4 fecha real: won_at / shopify_event_at se resuelven desde orders.shopify_created_at", () => {
    expect(
      body,
      "INV-4: no se lee orders.shopify_created_at para la fecha real",
    ).toContain("shopify_created_at");
    expect(
      body,
      "INV-4: won_at no cae a la fecha del pedido con fallback now()",
    ).toMatch(/coalesce\(v_order_created,\s*now\(\)\)/);
    // shopify_event_at debe poblarse en las entradas de historial.
    expect(body, "INV-4: las entradas de historial no setean shopify_event_at").toContain(
      "shopify_event_at",
    );
  });

  it("INV-5 outbound: la hija hereda is_outbound de la F1", () => {
    // La columna is_outbound debe estar en la lista del INSERT de la hija...
    expect(
      body,
      "INV-5: el INSERT de la hija no lista la columna is_outbound",
    ).toContain("is_outbound");
    // ...y su valor debe ser el de la F1 (denormalización que recorre el ciclo).
    expect(
      body,
      "INV-5: la hija no hereda is_outbound de la F1 (v_f1.is_outbound)",
    ).toContain("v_f1.is_outbound");
  });
});
