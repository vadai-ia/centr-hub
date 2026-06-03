/* eslint-disable no-console */
/**
 * Harness READ-ONLY de diagnóstico del "tag fantasma" (fix M7.2 #2).
 * NO modifica nada. Inspecciona la fila de tag_mappings, sus variantes
 * de normalización (con/sin acento, con/sin espacio) y el conteo real
 * de entidades que las llevan, para determinar el origen.
 *
 * Uso:
 *   npx tsx scripts/shopify/harness-diagnose-phantom-tag.ts \
 *     --org-slug centr --needle ginaj
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { withTenantContext } from "@/lib/tenant/context";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function parseArgs() {
  const argv = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    const v = argv[i + 1];
    if (k && v) out[k] = v;
  }
  if (!out["org-slug"] || !out.needle) {
    console.error("Uso: tsx harness-diagnose-phantom-tag.ts --org-slug <s> --needle <substr>");
    process.exit(2);
  }
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();
// Strip de diacríticos U+0300–U+036F (codepoints ASCII, sin property escapes).
const stripAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

async function main() {
  const args = parseArgs();
  const needle = args.needle.toLowerCase();
  const org = await getOrganizationBySlug(args["org-slug"]);
  if (!org) { console.error("org no encontrada"); process.exit(1); }

  const orgId = org.id;
  await withTenantContext(orgId as UUID, async () => {
    const supabase = getSupabaseAdminClient();

    // 1) Filas de tag_mappings que matchean el needle.
    const { data: maps } = await supabase
      .from("tag_mappings")
      .select("id, normalized_tag, original_tag, classification, mapped_membership_id, created_by_user_id, created_at, updated_at")
      .eq("organization_id", org.id);
    const candidates = (maps ?? []).filter((m) =>
      String(m.normalized_tag).toLowerCase().includes(needle) ||
      String(m.original_tag).toLowerCase().includes(needle),
    );

    console.log("=== tag_mappings que matchean", JSON.stringify(needle), "===");
    for (const m of candidates) {
      console.log({
        normalized_tag: m.normalized_tag,
        original_tag: m.original_tag,
        classification: m.classification,
        mapped_membership_id: m.mapped_membership_id,
        created_by_user_id: m.created_by_user_id,
        created_at: m.created_at,
        updated_at: m.updated_at,
      });
    }

    // 2) Para cada variante, contar entidades reales que la llevan
    //    (match exacto normalizado, y match ignorando acentos).
    async function loadRows(table: "contacts" | "orders") {
      const { data } = await supabase
        .from(table).select("id, shopify_tags")
        .eq("organization_id", orgId).limit(50000);
      return (data ?? []) as Array<{ id: string; shopify_tags: string[] | null }>;
    }
    const contacts = await loadRows("contacts");
    const orders = await loadRows("orders");

    for (const m of candidates) {
      const nt = String(m.normalized_tag);
      const exact = (rows: Array<{ shopify_tags: string[] | null }>) =>
        rows.filter((r) => (r.shopify_tags ?? []).some((t) => norm(t) === nt)).length;
      const accentInsensitive = (rows: Array<{ shopify_tags: string[] | null }>) =>
        rows.filter((r) => (r.shopify_tags ?? []).some((t) => stripAccents(norm(t)) === stripAccents(nt))).length;
      console.log(`\n--- "${nt}" ---`);
      console.log("  match exacto    -> contactos:", exact(contacts), "| orders:", exact(orders));
      console.log("  ignorando acento-> contactos:", accentInsensitive(contacts), "| orders:", accentInsensitive(orders));
    }

    // 3) ¿La normalización actual (solo lower+trim) preserva acentos?
    console.log('\n=== Sanity de normalización actual (trim+lowercase, SIN strip de acentos) ===');
    console.log('  "GinaJiménez" ->', JSON.stringify(norm("GinaJiménez")));
    console.log('  "Gina Jiménez" ->', JSON.stringify(norm("Gina Jiménez")));
    console.log('  strip-accents("ginajiménez") ->', JSON.stringify(stripAccents("ginajiménez")));

    // 4) Audit log que mencione el needle (reclasificaciones, reprocesos).
    const { data: audits } = await supabase
      .from("audit_log")
      .select("event_type, payload, actor_user_id, created_at")
      .eq("organization_id", org.id)
      .in("event_type", ["tag_reclassified", "tag_attribution_reprocessed"])
      .order("created_at", { ascending: false }).limit(50);
    const related = (audits ?? []).filter((a) =>
      JSON.stringify(a.payload ?? {}).toLowerCase().includes(needle));
    console.log("\n=== audit_log relacionado (tag_reclassified / reprocessed) ===");
    for (const a of related) {
      console.log({ created_at: a.created_at, event_type: a.event_type, actor: a.actor_user_id, payload: a.payload });
    }
    if (related.length === 0) console.log("  (ninguno)");
  }, { source: "script" });
}

main().catch((err: Error) => { console.error("harness falló:", err.message); process.exit(1); });
