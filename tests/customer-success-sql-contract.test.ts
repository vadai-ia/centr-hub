import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CUSTOMER_SUCCESS_ROLE_KEY } from "@/lib/auth/capabilities";

/**
 * Guard estático del contrato "Customer Success" (0047). Sin infra nueva
 * (no levanta Postgres).
 *
 * El acoplamiento crítico que protege: la key del rol (`customer-success`)
 * vive en DOS lados que `tsc` no puede correlacionar — la constante TS que
 * usa el selector/listado, y la función SQL que resuelve el CS por defecto
 * al nacer una opp de Post-venta. Si alguien renombra el rol en un solo
 * lado, la feature se desconecta EN SILENCIO: el selector se queda vacío o
 * las opps nuevas dejan de recibir Customer Success, sin ningún error.
 *
 * También asierta los dos invariantes de la ranura:
 *  - el trigger solo rellena cuando viene NULL (nunca pisa una asignación);
 *  - el relleno automático es exclusivo de `post_venta`.
 */

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.resolve(ROOT, "supabase", "migrations");

/** Migración de mayor número que contiene la firma dada. */
function latestMigrationDefining(signature: string): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  let latest: { file: string; sql: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    if (sql.toLowerCase().includes(signature.toLowerCase())) {
      latest = { file, sql };
    }
  }
  if (!latest) throw new Error(`Ninguna migración define ${signature}`);
  return latest;
}

describe("contrato: Customer Success (TS ↔ SQL)", () => {
  it("la función SQL del CS por defecto filtra por la MISMA key de rol que el TS", () => {
    const { sql } = latestMigrationDefining(
      "function public.default_customer_success_membership_id",
    );
    expect(
      sql.includes(`'${CUSTOMER_SUCCESS_ROLE_KEY}'`),
      `la migración debe filtrar memberships por role = '${CUSTOMER_SUCCESS_ROLE_KEY}' ` +
        "(la misma key que CUSTOMER_SUCCESS_ROLE_KEY en lib/auth/capabilities.ts)",
    ).toBe(true);
  });

  it("el trigger solo rellena cuando la ranura viene NULL (nunca pisa)", () => {
    const { sql } = latestMigrationDefining(
      "function public.tg_opportunity_default_customer_success",
    );
    const normalized = sql.toLowerCase().replace(/\s+/g, " ");
    expect(
      normalized.includes("customer_success_membership_id is null"),
      "el trigger debe condicionar el relleno a que la columna sea NULL",
    ).toBe(true);
  });

  it("el relleno automático es exclusivo del funnel post_venta", () => {
    const { sql } = latestMigrationDefining(
      "function public.tg_opportunity_default_customer_success",
    );
    const normalized = sql.toLowerCase().replace(/\s+/g, " ");
    expect(normalized).toContain("new.funnel = 'post_venta'");
  });

  it("el trigger corre BEFORE INSERT sobre opportunities (cubre las 4 vías de creación)", () => {
    const { sql } = latestMigrationDefining(
      "trigger opportunities_default_customer_success",
    );
    const normalized = sql.toLowerCase().replace(/\s+/g, " ");
    expect(normalized).toContain(
      "before insert or update of funnel on public.opportunities",
    );
  });

  it("el invariante de 0039 sigue intacto: el selector de ASESOR sigue cableado a 'vendedor'", () => {
    const users = readFileSync(
      path.resolve(ROOT, "lib", "db", "users.ts"),
      "utf8",
    );
    // listActiveRealVendors NO debe haber pasado a aceptar Customer Success:
    // un CS nunca entra al round-robin, al mapeo de tags ni al selector de asesor.
    const listVendors = users.slice(
      users.indexOf("export async function listActiveRealVendors"),
      users.indexOf("export async function listRotationEligibleVendors"),
    );
    expect(listVendors).toContain('.eq("role", "vendedor")');
    expect(listVendors).not.toContain(CUSTOMER_SUCCESS_ROLE_KEY);
  });
});
