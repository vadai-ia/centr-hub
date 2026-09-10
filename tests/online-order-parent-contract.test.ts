import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guard estático del contrato "compra online sin madre" (0052). Sin infra
 * nueva (no levanta Postgres).
 *
 * El acoplamiento que protege vive en DOS lados que `tsc` no puede
 * correlacionar:
 *
 *   - la CHECK constraint de BD admite `post_venta` sin `parent` **solo si
 *     hay `shopify_order_id`**;
 *   - el servicio que crea esas opps es quien tiene que ponerlo.
 *
 * Si alguien vuelve a exigir madre en la constraint, o deja de anclar el
 * pedido en el servicio, el fallo NO aparece en tests unitarios ni en
 * `tsc`: aparece en producción, al insertar, y con un mensaje
 * (`violates check constraint`) que no dice nada de compras online. Es
 * exactamente cómo se descubrió la primera vez.
 */

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.resolve(ROOT, "supabase", "migrations");

/** Migración de mayor número que redefine la constraint. */
function latestConstraintDefinition(): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  let latest: { file: string; sql: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    if (/add\s+constraint\s+opportunities_parent_funnel_check/i.test(sql)) {
      latest = { file, sql };
    }
  }
  if (!latest) throw new Error("Ninguna migración define opportunities_parent_funnel_check");
  return latest;
}

/** Cuerpo del CHECK, normalizado a minúsculas y sin saltos de línea. */
function constraintBody(): string {
  const { sql } = latestConstraintDefinition();
  const idx = sql.toLowerCase().lastIndexOf("add constraint opportunities_parent_funnel_check");
  return sql.slice(idx).toLowerCase().replace(/\s+/g, " ");
}

describe("contrato SQL — Post-venta sin madre (compra online)", () => {
  it("la constraint vigente admite post_venta con parent NULL", () => {
    const body = constraintBody();
    // La rama nueva: post_venta + parent null + order not null.
    expect(body).toMatch(
      /funnel = 'post_venta'\s* and parent_opportunity_id is null\s* and shopify_order_id is not null/,
    );
  });

  it("pero SOLO si está anclada a un pedido — no admite huérfanas", () => {
    const body = constraintBody();
    // No debe existir una rama que acepte post_venta sin madre y sin pedido.
    const ramaHuerfana =
      /funnel = 'post_venta'\s* and parent_opportunity_id is null\s*\)/;
    expect(body).not.toMatch(ramaHuerfana);
    expect(body).toContain("shopify_order_id is not null");
  });

  it("Venta y Outbound siguen exigiendo parent NULL", () => {
    const body = constraintBody();
    expect(body).toMatch(/funnel = 'venta'\s* and parent_opportunity_id is null/);
    expect(body).toMatch(/funnel = 'outbound'\s* and parent_opportunity_id is null/);
  });

  it("y la hija normal de Post-venta sigue exigiendo madre", () => {
    const body = constraintBody();
    expect(body).toMatch(/funnel = 'post_venta'\s* and parent_opportunity_id is not null/);
  });
});

describe("contrato TS — el servicio ancla el pedido", () => {
  const SERVICE = path.resolve(ROOT, "lib", "services", "online-order-opportunity.ts");

  it("createOpportunity recibe shopify_order_id del pedido", () => {
    const src = readFileSync(SERVICE, "utf8");
    // Sin esto, el insert viola la constraint en producción.
    expect(src).toMatch(/shopify_order_id:\s*order\.shopify_order_id/);
  });

  it("y NO inventa una madre para pasar la constraint", () => {
    const src = readFileSync(SERVICE, "utf8");
    // La tentación al ver el error es colgarla de cualquier opp: eso
    // ensuciaría la atribución de una venta que nadie trabajó.
    expect(src).toMatch(/parent_opportunity_id:\s*null/);
  });
});
