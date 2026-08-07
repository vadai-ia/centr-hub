import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ALL_TAB_KEYS, TAB_REGISTRY } from "@/lib/auth/capabilities";
import {
  ORG_SLUG_MAX_LENGTH,
  deriveOrgSlug,
  validateOrgSlug,
} from "@/lib/services/organization-slug";

/**
 * Admin → Organizaciones (0048). Dos bloques:
 *
 *  1. La derivación del slug — es IRREVERSIBLE (se congela al crear la org y
 *     queda cableado al webhook de Post-venta, a `--org-slug` y al email del
 *     usuario "Histórico"), así que la función que lo produce merece pruebas
 *     de verdad, no confianza.
 *
 *  2. El contrato TS ↔ SQL de la pestaña nueva, con la misma mecánica del
 *     guard de Customer Success: la key `admin-organizaciones` vive en el
 *     TAB_REGISTRY y en la migración (backfill de roles existentes + seed de
 *     `bootstrap_organization` para orgs nuevas). Si alguien la renombra de
 *     un solo lado, la pestaña desaparece EN SILENCIO — el rol la pide, la
 *     BD no la tiene, y `requireTabOrRedirect` manda al pipeline sin error.
 */

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.resolve(ROOT, "supabase", "migrations");
const TAB_KEY = "admin-organizaciones";

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

describe("slug de organización", () => {
  it("deriva un slug ASCII del nombre visible", () => {
    expect(deriveOrgSlug("Centr Colombia")).toBe("centr-colombia");
    expect(deriveOrgSlug("Rustr")).toBe("rustr");
  });

  it("pliega los acentos a su letra base en vez de convertirlos en guiones", () => {
    // "diseño" -> "diseno", no "dise-o": el slug queda congelado para siempre,
    // un guión accidental en medio se vuelve permanente.
    expect(deriveOrgSlug("Diseño México")).toBe("diseno-mexico");
    expect(deriveOrgSlug("Ártica")).toBe("artica");
  });

  it("colapsa separadores y no deja guiones en los extremos", () => {
    expect(deriveOrgSlug("  Centr   &   Co.  ")).toBe("centr-co");
    expect(deriveOrgSlug("--Centr--")).toBe("centr");
  });

  it("respeta el largo máximo sin dejar un guión colgando al truncar", () => {
    const slug = deriveOrgSlug("a".repeat(ORG_SLUG_MAX_LENGTH) + " colombia");
    expect(slug.length).toBeLessThanOrEqual(ORG_SLUG_MAX_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("un nombre sin caracteres ASCII válidos no produce slug utilizable", () => {
    const slug = deriveOrgSlug("!!! ???");
    expect(slug).toBe("");
    expect(validateOrgSlug(slug)).not.toBeNull();
  });

  it("rechaza mayúsculas, espacios y guiones en los extremos", () => {
    expect(validateOrgSlug("Centr")).not.toBeNull();
    expect(validateOrgSlug("centr colombia")).not.toBeNull();
    expect(validateOrgSlug("-centr")).not.toBeNull();
    expect(validateOrgSlug("centr-")).not.toBeNull();
    expect(validateOrgSlug("centr--co")).not.toBeNull();
    expect(validateOrgSlug("centr-colombia-2")).toBeNull();
  });
});

describe("contrato: pestaña Organizaciones (TS ↔ SQL)", () => {
  it("la key está registrada en el TAB_REGISTRY como pestaña de administración", () => {
    const tab = TAB_REGISTRY.find((t) => t.key === TAB_KEY);
    expect(tab, `${TAB_KEY} debe existir en TAB_REGISTRY`).toBeDefined();
    expect(tab?.section).toBe("admin");
    expect(tab?.href).toBe("/admin/organizaciones");
    expect(ALL_TAB_KEYS).toContain(TAB_KEY);
  });

  it("la migración la agrega a los roles admin/superadmin YA existentes", () => {
    const { sql } = latestMigrationDefining("bootstrap_organization_with_owner");
    const normalized = sql.toLowerCase().replace(/\s+/g, " ");
    expect(
      normalized.includes(`update public.roles set allowed_tabs = allowed_tabs || array['${TAB_KEY}']`),
      "sin el backfill, las orgs existentes (Centr, Rustr) nunca ven la pestaña",
    ).toBe(true);
  });

  it("`bootstrap_organization` la siembra para las orgs NUEVAS", () => {
    const { sql } = latestMigrationDefining("function public.bootstrap_organization(");
    // Debe aparecer en el allowed_tabs de superadmin Y de admin (2 ocurrencias
    // dentro del insert de roles).
    const seeds = sql.match(new RegExp(`'${TAB_KEY}'`, "g")) ?? [];
    expect(
      seeds.length,
      "la key debe estar en el allowed_tabs de superadmin y de admin",
    ).toBeGreaterThanOrEqual(2);
  });

  it("la creación de org y su membresía viven en la MISMA función SQL", () => {
    // El invariante: una org nunca queda sin nadie que pueda entrar. Si el
    // insert de membership se moviera a TS, un fallo entre ambas llamadas
    // dejaría un tenant huérfano rescatable solo por SQL manual.
    const { sql } = latestMigrationDefining("bootstrap_organization_with_owner");
    const body = sql.slice(sql.indexOf("function public.bootstrap_organization_with_owner"));
    const normalized = body.toLowerCase().replace(/\s+/g, " ");
    expect(normalized).toContain("v_org_id := public.bootstrap_organization(");
    expect(normalized).toContain("insert into public.memberships");
  });

  it("el RPC no es invocable por anon/authenticated", () => {
    const { sql } = latestMigrationDefining("bootstrap_organization_with_owner");
    const normalized = sql.toLowerCase().replace(/\s+/g, " ");
    expect(normalized).toContain(
      "revoke execute on function public.bootstrap_organization_with_owner(text, citext, uuid, text) from public, anon, authenticated",
    );
  });
});

describe("contrato: el slug NO se edita desde la pantalla", () => {
  it("la action de renombrar solo acepta id + name", () => {
    const src = readFileSync(
      path.resolve(ROOT, "lib", "actions", "admin-organizations.ts"),
      "utf8",
    );
    const start = src.indexOf("const renameSchema");
    const schema = src.slice(start, src.indexOf("});", start) + 3);
    expect(schema).toContain("id:");
    expect(schema).toContain("name:");
    // Un `slug` en el schema de rename significaría que alguien reabrió la
    // puerta que rompe el webhook de Post-venta y los scripts en silencio.
    expect(schema).not.toContain("slug");
  });

  it("renombrar no toca ninguna columna fuera de `name`", () => {
    const src = readFileSync(
      path.resolve(ROOT, "lib", "actions", "admin-organizations.ts"),
      "utf8",
    );
    expect(src).toContain("updateOrganization(target.org.id, { name: nextName })");
  });
});
