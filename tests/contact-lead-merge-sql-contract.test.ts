import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guard estático del RPC de fusión lead → cliente y de la guarda de
 * `activities` (0054). Sin Postgres.
 *
 * Por qué hace falta: el RPC es SQL puro — ni `tsc` ni la suite mockeada lo
 * ven. Y su invariante más frágil depende de OTRAS migraciones: si mañana se
 * agrega una tabla con `references public.contacts` y la fusión no la mueve,
 * el borrado del lead revienta (RESTRICT) o, peor, se lleva filas en silencio
 * (CASCADE). El primer test descubre esas tablas leyendo las migraciones.
 */

const DIR = path.resolve(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort()
  .map((f) => ({ file: f, sql: readFileSync(path.join(DIR, f), "utf8") }));

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

function latestDefining(signature: string): string {
  let latest: string | null = null;
  for (const m of MIGRATIONS) if (m.sql.toLowerCase().includes(signature)) latest = m.sql;
  if (!latest) throw new Error(`Ninguna migración define ${signature}`);
  return latest;
}

function fnBody(sql: string, signature: string): string {
  const start = sql.toLowerCase().indexOf(signature);
  const end = sql.indexOf("$$;", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return norm(sql.slice(start, end));
}

/** Tablas con una columna que referencia public.contacts, en cualquier migración. */
function tablesReferencingContacts(): Set<string> {
  const found = new Set<string>();
  for (const { sql } of MIGRATIONS) {
    const withoutComments = sql.replace(/--[^\n]*/g, "");
    for (const stmt of withoutComments.split(";")) {
      if (!/references\s+public\.contacts\b/i.test(stmt)) continue;
      const m = stmt.match(/(?:create|alter)\s+table\s+(?:if\s+not\s+exists\s+)?(?:only\s+)?public\.(\w+)/i);
      if (m && m[1].toLowerCase() !== "contacts") found.add(m[1].toLowerCase());
    }
  }
  return found;
}

const MERGE_SIG = "create or replace function public.merge_lead_contact_into_client";
const mergeSql = latestDefining(MERGE_SIG);
const merge = fnBody(mergeSql, MERGE_SIG);

describe("contrato SQL: fusión lead → cliente (0054)", () => {
  it("mueve TODAS las tablas que referencian contacts (si agregas una, este test te obliga a moverla)", () => {
    const tables = tablesReferencingContacts();
    // Sanidad del descubrimiento: si el parser dejara de encontrar estas, el
    // resto del test pasaría en vacío.
    for (const known of ["opportunities", "orders", "rule_executions", "activities", "tasks", "notifications"]) {
      expect(tables, `el descubrimiento debería encontrar ${known}`).toContain(known);
    }
    for (const t of Array.from(tables)) {
      expect(
        merge.includes(`update public.${t} set contact_id = v_client.id where contact_id = v_lead.id`),
        `la fusión debe re-apuntar public.${t}.contact_id al cliente antes de borrar el lead`,
      ).toBe(true);
    }
  });

  it("borra el lead SOLO al final, después de mover todo", () => {
    const del = merge.indexOf("delete from public.contacts where id = v_lead.id");
    expect(del).toBeGreaterThan(0);
    for (const t of Array.from(tablesReferencingContacts())) {
      expect(merge.indexOf(`update public.${t} set contact_id`)).toBeLessThan(del);
    }
  });

  it("dry-run no escribe: retorna antes del primer update", () => {
    const dry = merge.indexOf("'dry_run'");
    const firstUpdate = merge.indexOf("update public.");
    expect(dry).toBeGreaterThan(0);
    expect(dry).toBeLessThan(firstUpdate);
  });

  it("revalida bajo lock las precondiciones que decidió el servicio", () => {
    for (const reason of [
      "'lead_is_a_client'",
      "'client_not_a_client'",
      "'phone_mismatch'",
      "'ambiguous_phone'",
      "'whaapy_identity_conflict'",
      "'lead_has_orders'",
    ]) {
      expect(merge).toContain(reason);
    }
    expect(merge).toContain("for update");
  });

  it("libera el id de Whaapy del lead ANTES de asignarlo al cliente (índice único)", () => {
    const free = merge.indexOf("set whaapy_contact_id = null where id = v_lead.id");
    const assign = merge.indexOf("whaapy_contact_id = coalesce(c.whaapy_contact_id, v_whaapy)");
    expect(free).toBeGreaterThan(0);
    expect(free).toBeLessThan(assign);
  });

  it("el cliente conserva sus datos: del lead solo toma lo que le falta", () => {
    expect(merge).toContain("full_name = coalesce(c.full_name, v_lead.full_name)");
    expect(merge).toContain("email = coalesce(c.email, v_lead.email)");
    expect(merge).toContain("assigned_advisor_id = coalesce(c.assigned_advisor_id, v_lead.assigned_advisor_id)");
  });

  it("no marca la escritura como de plataforma (R11 descartaría webhooks legítimos como eco)", () => {
    expect(merge).not.toContain("last_modified_source");
  });

  it("es SECURITY DEFINER y solo lo ejecuta service_role", () => {
    const sql = norm(mergeSql);
    expect(sql).toContain("security definer");
    expect(sql).toContain(
      "revoke execute on function public.merge_lead_contact_into_client(uuid, uuid, boolean) from public, anon, authenticated",
    );
    expect(sql).toContain(
      "grant execute on function public.merge_lead_contact_into_client(uuid, uuid, boolean) to service_role",
    );
  });
});

describe("contrato SQL: activities sigue inmutable salvo re-apuntar contact_id en una fusión", () => {
  const GUARD_SIG = "create or replace function public.tg_activities_guard";
  const guardSql = latestDefining(GUARD_SIG);
  const guard = fnBody(guardSql, GUARD_SIG);

  it("DELETE sigue bloqueado siempre", () => {
    expect(guard).toContain("tg_op = 'delete'");
    expect(guard).toContain("activities no acepta delete");
  });

  it("UPDATE exige la bandera transaccional de fusión", () => {
    expect(guard).toContain("current_setting('centr.contact_merge', true)");
  });

  it("el contenido sigue inmutable: lo único que puede cambiar es contact_id", () => {
    for (const col of ["description", "payload", "activity_type", "created_at", "triggered_by_user_id", "opportunity_id"]) {
      expect(guard).toContain(`old.${col}`);
    }
    expect(guard).not.toContain("old.contact_id");
  });

  it("la bandera se enciende SOLO alrededor del update de activities", () => {
    const on = merge.indexOf("set_config('centr.contact_merge', 'on', true)");
    const upd = merge.indexOf("update public.activities set contact_id");
    const off = merge.indexOf("set_config('centr.contact_merge', 'off', true)");
    expect(on).toBeGreaterThan(0);
    expect(on).toBeLessThan(upd);
    expect(upd).toBeLessThan(off);
  });

  it("el trigger vigente sobre activities es la guarda, no el bloqueo genérico", () => {
    const sql = norm(guardSql);
    expect(sql).toContain("drop trigger if exists activities_no_update on public.activities");
    expect(sql).toContain("create trigger activities_guard before update or delete on public.activities");
  });
});
