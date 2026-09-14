/* eslint-disable no-console */
/**
 * DIAGNÓSTICO READ-ONLY de contactos duplicados. NO escribe nada.
 *
 * Responde: ¿cuántas personas existen como DOS o más tarjetas, y por qué no
 * las unió el identity matching? Agrupa por dos llaves:
 *
 *  - teléfono: últimos 10 dígitos (atrapa la misma persona guardada como
 *    "+5215512345678" vs "+525512345678", el prefijo móvil viejo de MX).
 *  - correo: lowercase + trim.
 *
 * Y distingue si el grupo comparte el teléfono EXACTO (entonces el matching
 * debió unirlos y algo más falló) o solo los últimos 10 dígitos (entonces la
 * causa es de formato). Esa distinción decide el arreglo.
 *
 * Teléfonos y correos se enmascaran en la salida.
 *
 * Uso: npm run maintenance:inspect-duplicate-contacts -- --org-slug centr [--name arturo]
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { fetchAllPaged } from "@/lib/db/paginate";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

interface Row {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  shopify_customer_id: string | null;
  whaapy_contact_id: string | null;
  assigned_advisor_id: string | null;
  created_at: string;
  last_modified_source: string | null;
}

const maskPhone = (p: string | null) =>
  p ? `${p.slice(0, 4)}…${p.slice(-3)} (${p.length}c)` : "—";
const maskEmail = (e: string | null) => {
  if (!e) return "—";
  const [u, d] = e.split("@");
  return `${(u ?? "").slice(0, 2)}…@${d ?? "?"}`;
};
const last10 = (p: string | null) => {
  const digits = (p ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
};
const kind = (r: Row) => (r.shopify_customer_id ? "cliente" : "lead");

async function main() {
  const argv = process.argv.slice(2);
  let orgSlug = "centr";
  let name: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? "centr";
    else if (argv[i] === "--name") name = (argv[++i] ?? "").toLowerCase();
  }
  const org = await getOrganizationBySlug(orgSlug);
  if (!org) throw new Error(`No existe la org ${orgSlug}`);
  const supabase = getSupabaseAdminClient();

  const rows = await fetchAllPaged<Row>(() =>
    supabase
      .from("contacts")
      .select("id, full_name, phone, email, shopify_customer_id, whaapy_contact_id, assigned_advisor_id, created_at, last_modified_source")
      .eq("organization_id", org.id)
      .is("anonymized_at", null),
  );
  console.log(`\n=== CONTACTOS DUPLICADOS (org=${orgSlug}) ===`);
  console.log(`Contactos vivos: ${rows.length}`);

  const byPhone = new Map<string, Row[]>();
  const byEmail = new Map<string, Row[]>();
  const phoneFormats = new Map<string, number>();
  for (const r of rows) {
    const k = last10(r.phone);
    if (k) byPhone.set(k, [...(byPhone.get(k) ?? []), r]);
    const e = r.email?.trim().toLowerCase();
    if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), r]);
    if (r.phone) {
      const shape = r.phone.startsWith("+521") ? "+521… (móvil viejo)" : r.phone.startsWith("+52") ? "+52…" : r.phone.startsWith("+") ? "+otro país" : "sin + (no E.164)";
      phoneFormats.set(shape, (phoneFormats.get(shape) ?? 0) + 1);
    }
  }
  console.log("\nFormatos de teléfono guardados:");
  for (const [s, n] of Array.from(phoneFormats)) console.log(`   ${s.padEnd(24)} ${n}`);

  const phoneDupes = Array.from(byPhone.values()).filter((g) => g.length > 1);
  const emailDupes = Array.from(byEmail.values()).filter((g) => g.length > 1);
  const exactPhone = phoneDupes.filter((g) => new Set(g.map((r) => r.phone)).size === 1);
  const formatOnly = phoneDupes.filter((g) => new Set(g.map((r) => r.phone)).size > 1);
  const combo = new Map<string, number>();
  for (const g of phoneDupes) {
    const key = g.map(kind).sort().join("+");
    combo.set(key, (combo.get(key) ?? 0) + 1);
  }

  console.log(`\nGrupos duplicados por TELÉFONO (últimos 10 dígitos): ${phoneDupes.length}`);
  console.log(`   con teléfono EXACTAMENTE igual:        ${exactPhone.length}`);
  console.log(`   solo coinciden en formato distinto:    ${formatOnly.length}`);
  console.log("   combinaciones:");
  for (const [k, n] of Array.from(combo)) console.log(`      ${k.padEnd(20)} ${n}`);
  console.log(`\nGrupos duplicados por CORREO: ${emailDupes.length}`);

  const { count: cPhone } = await supabase.from("audit_log").select("id", { count: "exact", head: true })
    .eq("organization_id", org.id).eq("event_type", "identity_match_conflict_phone");
  const { count: cEmail } = await supabase.from("audit_log").select("id", { count: "exact", head: true })
    .eq("organization_id", org.id).eq("event_type", "identity_match_conflict_email");
  console.log(`\nAudit identity_match_conflict_phone: ${cPhone ?? 0} · _email: ${cEmail ?? 0}`);

  const show = (label: string, groups: Row[][]) => {
    console.log(`\n--- ${label} (máx. 12) ---`);
    for (const g of groups.slice(0, 12)) {
      console.log("  •");
      for (const r of g.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
        console.log(`     ${kind(r).padEnd(7)} ${(r.full_name ?? "(sin nombre)").slice(0, 28).padEnd(28)} tel=${maskPhone(r.phone).padEnd(18)} mail=${maskEmail(r.email).padEnd(18)} shop=${r.shopify_customer_id ? "sí" : "no"} whaapy=${r.whaapy_contact_id ? "sí" : "no"} asesor=${r.assigned_advisor_id ? "sí" : "no"} src=${r.last_modified_source} creado=${r.created_at.slice(0, 10)}`);
      }
    }
  };
  if (name) {
    const hits = rows.filter((r) => (r.full_name ?? "").toLowerCase().includes(name!));
    show(`Coincidencias de nombre "${name}"`, [hits]);
  }
  show("Muestra: mismo teléfono exacto", exactPhone);
  show("Muestra: mismo número, formato distinto", formatOnly);
  console.log("");
}
main().catch((e) => { console.error(e); process.exit(1); });
