import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guard estático de la ranura de ASESOR (`memberships.is_advisor`, 0050).
 *
 * Qué protege: el sistema listaba asesores con `role = 'vendedor'`, asumiendo
 * que el rol es el puesto ÚNICO de la persona. Ese supuesto se rompió con el
 * primer ascenso real (vendedora con cartera viva → admin/líder que sigue
 * vendiendo): al cambiarle el rol desapareció EN SILENCIO del selector de
 * asesor, del mapeo de tags de Shopify, del desglose del dashboard y de sus
 * metas. Sus datos nunca se movieron — las FK cuelgan de `membership.id` —,
 * pero dejó de ser asignable y sus ventas nuevas dejaron de atribuírsele.
 *
 * La regresión es invisible para `tsc` y para la suite mockeada: `.eq("role",
 * "vendedor")` compila igual de bien que `.eq("is_advisor", true)`, y el SQL
 * ni siquiera lo ve TypeScript. De ahí este guard.
 */

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.resolve(ROOT, "supabase", "migrations");

function latestMigrationDefining(signature: string): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  let latest: { file: string; sql: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    if (sql.toLowerCase().includes(signature.toLowerCase())) latest = { file, sql };
  }
  if (!latest) throw new Error(`Ninguna migración define ${signature}`);
  return latest;
}

const usersDb = readFileSync(path.resolve(ROOT, "lib", "db", "users.ts"), "utf8");

/** Cuerpo de una función exportada de lib/db/users.ts. */
function fnBody(name: string): string {
  const start = usersDb.indexOf(`export async function ${name}`);
  expect(start, `no se encontró ${name} en lib/db/users.ts`).toBeGreaterThanOrEqual(0);
  const next = usersDb.indexOf("\nexport ", start + 1);
  return usersDb.slice(start, next === -1 ? undefined : next);
}

describe("contrato: la ranura de asesor es ortogonal al rol (0050)", () => {
  // Cada una de estas alimenta un consumidor donde el ascenso rompía algo
  // distinto. Si alguna vuelve a filtrar por rol, ese consumidor pierde en
  // silencio a quien vende sin tener el rol vendedor.
  const advisorQueries: Array<[fn: string, consumidor: string]> = [
    ["listActiveRealVendors", "selector de asesor, asignación manual, handoff"],
    ["listRealVendorsForMapping", "mapeo de tags de Shopify, desglose del dashboard, metas"],
    ["listRotationEligibleVendors", "round-robin de leads por webhook"],
    ["findActiveMembershipIdByWhaapyAgentId", "asignación por agente de Whaapy"],
  ];

  for (const [fn, consumidor] of advisorQueries) {
    it(`${fn} filtra por is_advisor, no por rol (${consumidor})`, () => {
      const body = fnBody(fn);
      expect(
        body.includes('.eq("is_advisor", true)'),
        `${fn} debe filtrar por la ranura is_advisor`,
      ).toBe(true);
      expect(
        body.includes('.eq("role", "vendedor")'),
        `${fn} NO debe volver a filtrar por role='vendedor': excluye en silencio ` +
          "a quien opera cartera sin tener ese rol (el caso del ascenso).",
      ).toBe(false);
    });
  }

  it("listActiveCustomerSuccess sigue cableado a su ROL (no a la ranura de asesor)", () => {
    // 0047 intacto: ser Customer Success no es ser asesor. Son dos ranuras
    // distintas sobre la misma oportunidad de Post-venta.
    const body = fnBody("listActiveCustomerSuccess");
    expect(body).toContain("CUSTOMER_SUCCESS_ROLE_KEY");
    expect(body.includes('.eq("is_advisor", true)')).toBe(false);
  });

  describe("SQL", () => {
    const { sql } = latestMigrationDefining(
      "function public.tg_membership_sync_is_advisor",
    );
    const normalized = sql.toLowerCase().replace(/\s+/g, " ");

    it("INV-1: el rol vendedor fuerza la ranura encendida", () => {
      expect(normalized).toContain("if new.role = 'vendedor' then");
      expect(normalized).toContain("new.is_advisor := true");
    });

    it("INV-2: NADA en el trigger apaga la ranura (el ascenso conserva la cartera)", () => {
      // Es el corazón del fix: si alguien agrega un `else new.is_advisor :=
      // false`, el ascenso vuelve a romper la atribución en silencio.
      expect(
        normalized.includes("is_advisor := false"),
        "el trigger NUNCA debe apagar is_advisor: salir del rol vendedor no " +
          "significa dejar de vender (solo el admin la apaga a mano).",
      ).toBe(false);
    });

    it("el trigger corre BEFORE INSERT OR UPDATE OF role (cubre todas las vías, incl. el bootstrap SQL)", () => {
      expect(normalized).toContain(
        "before insert or update of role on public.memberships",
      );
    });

    it("el backfill recupera a quien YA tenía cartera aunque su rol ya no sea vendedor", () => {
      // Sin esta rama, quien fue ascendido ANTES de la migración se queda
      // invisible: el backfill por rol no lo alcanza.
      expect(normalized).toContain("o.assigned_advisor_id = m.id");
      expect(normalized).toContain("t.mapped_membership_id = m.id");
    });

    it("el backfill NO nombra ninguna organización (es dirigido por datos)", () => {
      // Debe corregir cada tenant donde la persona tenga historia y dejar
      // intacto aquel donde no ha operado nunca.
      expect(/organizations?\s*\.\s*slug|slug\s*=\s*'/i.test(sql)).toBe(false);
    });
  });

  it("el RPC de handoff valida al asesor por la ranura, no por el rol", () => {
    const { sql } = latestMigrationDefining(
      "create or replace function public.handoff_outbound_opportunity",
    );
    const body = sql.slice(
      sql.toLowerCase().indexOf("create or replace function public.handoff_outbound_opportunity"),
    );
    expect(body.toLowerCase()).toContain("v_advisor.is_advisor is not true");
    expect(
      body.toLowerCase().includes("v_advisor.role <> 'vendedor'"),
      "el handoff no debe rechazar a un admin/líder que opera cartera",
    ).toBe(false);
  });
});
