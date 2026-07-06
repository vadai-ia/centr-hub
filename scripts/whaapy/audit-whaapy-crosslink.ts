/* eslint-disable no-console */
/**
 * Audit READ-ONLY — mitad Whaapy del riesgo de duplicados de contacto
 * para el backfill. NO escribe nada.
 *
 * Mide:
 *   - Whaapy contacts cuyo teléfono NO normaliza a E.164.
 *   - Whaapy contacts que comparten teléfono con un customer de Shopify
 *     (los pares que DEBERÍAN enlazarse — candidatos reales a
 *     colisión/race). Subdivide en:
 *       · match limpio (1 solo customer Shopify) → auto-link feliz.
 *       · match ambiguo (>1 customer Shopify) → conflict_create_new.
 *   - Diagnóstico strict-E.164 vs loose-últimos-10-dígitos: si el loose
 *     encuentra muchos más matches que el strict, la normalización está
 *     perdiendo enlaces (ej. forma móvil legacy `+521…` de Whaapy).
 *
 * Usa el MISMO `normalizePhone` (libphonenumber MX) que el backfill.
 * Revela SIN enmascarar el número placeholder más compartido de Shopify
 * + sus customer IDs/nombres (para que el operador identifique test vs
 * cliente real). El resto queda enmascarado.
 *
 * Uso:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/whaapy/audit-whaapy-crosslink.ts --org-slug centr
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { shopifyGraphql } from "@/lib/shopify/admin-client";
import { whaapyRest } from "@/lib/whaapy/admin-client";
import { normalizePhone } from "@/lib/services/identity-matching";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function parseArgs() {
  let orgSlug = "centr";
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? "centr";
  }
  return { orgSlug };
}

function pickPhone(profile: string | null | undefined, addrPhone: string | null | undefined): string | null {
  const p = (profile ?? "").trim();
  if (p.length > 0) return profile ?? null;
  const a = (addrPhone ?? "").trim();
  if (a.length > 0) return addrPhone ?? null;
  return null;
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}
function last10(s: string): string | null {
  const d = digitsOnly(s);
  return d.length >= 10 ? d.slice(-10) : null;
}
function maskPhone(e164: string): string {
  if (e164.length <= 5) return "***";
  return e164.slice(0, 3) + "*".repeat(Math.max(0, e164.length - 7)) + e164.slice(-4);
}

// -------- Shopify pass: build normalized-phone indexes --------
interface ShopCust { id: string; name: string | null }

async function buildShopifyIndexes(opts: { organizationId: UUID; shopDomain: string }) {
  const meta = await shopifyGraphql<{
    __type: { fields: Array<{ name: string }> };
    customersCount: { count: number };
  }>(opts, `{ __type(name:"Customer"){fields{name}} customersCount{count} }`);
  const names = new Set(meta.__type.fields.map((f) => f.name));
  const phoneSel = names.has("phone") ? "phone" : names.has("defaultPhoneNumber") ? "defaultPhoneNumber { phoneNumber }" : "";
  const query = `query($cursor:String){ customers(first:250, after:$cursor){
    pageInfo{hasNextPage endCursor}
    edges{ node{ id displayName ${phoneSel} defaultAddress{ phone } } }
  } }`;

  const strict = new Map<string, ShopCust[]>();   // E.164 -> customers
  const loose = new Map<string, Set<string>>();    // last10 -> customerIds
  let cursor: string | null = null;
  let scanned = 0;
  for (;;) {
    const data: {
      customers: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: Array<{ node: {
        id: string; displayName?: string | null; phone?: string | null;
        defaultPhoneNumber?: { phoneNumber?: string | null } | null; defaultAddress?: { phone?: string | null } | null;
      } }> };
    } = await shopifyGraphql(opts, query, { cursor });
    for (const { node } of data.customers.edges) {
      scanned++;
      const profile = node.phone ?? node.defaultPhoneNumber?.phoneNumber ?? null;
      const raw = pickPhone(profile, node.defaultAddress?.phone ?? null);
      if (!raw) continue;
      const cust: ShopCust = { id: node.id, name: node.displayName ?? null };
      const norm = normalizePhone(raw, "MX");
      if (norm) {
        const arr = strict.get(norm) ?? [];
        arr.push(cust);
        strict.set(norm, arr);
      }
      const l10 = last10(raw);
      if (l10) {
        const set = loose.get(l10) ?? new Set();
        set.add(node.id);
        loose.set(l10, set);
      }
    }
    if (!data.customers.pageInfo.hasNextPage) break;
    cursor = data.customers.pageInfo.endCursor;
  }
  return { strict, loose, scanned };
}

// -------- Whaapy pass --------
interface WhaapyContact { id: string; phone_number: string | null; name: string | null; source: string | null }

async function main() {
  const { orgSlug } = parseArgs();
  void getSupabaseAdminClient();
  const org = await getOrganizationBySlug(orgSlug);
  if (!org) throw new Error(`org ${orgSlug} no encontrada`);
  if (!org.shopify_store_domain) throw new Error(`org ${orgSlug} sin shopify_store_domain`);
  const shopOpts = { organizationId: org.id as UUID, shopDomain: org.shopify_store_domain };
  const whaapyCtx = { organizationId: org.id as UUID };

  console.log("Building Shopify normalized-phone index…");
  const shop = await buildShopifyIndexes(shopOpts);
  console.log(`  Shopify customers scanned: ${shop.scanned} (distinct E.164: ${shop.strict.size})`);

  console.log("\nPaginating Whaapy contacts…");
  let cursor: string | null = null;
  let total = 0;
  let noPhone = 0;
  let failNorm = 0;
  let shouldLinkStrict = 0;      // whaapy phone matches >=1 shopify customer (strict E.164)
  let cleanLink = 0;             //   ... exactly 1 shopify customer
  let ambiguousConflict = 0;     //   ... >1 shopify customer -> conflict_create_new
  let shouldLinkLoose = 0;       // whaapy phone matches shopify via last-10-digits
  let looseOnly = 0;             // matched loose but NOT strict -> normalization dropped the link
  let reportedTotal: number | null = null;
  const whaapyStrict = new Map<string, number>(); // detect intra-whaapy dup phones
  const failSamples: string[] = [];

  for (;;) {
    const qs = `/contacts/v1?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const resp = await whaapyRest<{
      contacts: WhaapyContact[];
      pagination: { total: number; has_more: boolean; next_cursor: string | null };
    }>(whaapyCtx, "GET", qs);
    reportedTotal = resp.pagination?.total ?? reportedTotal;
    for (const c of resp.contacts ?? []) {
      total++;
      const raw = (c.phone_number ?? "").trim() || null;
      if (!raw) { noPhone++; continue; }
      const norm = normalizePhone(raw, "MX");
      const l10 = last10(raw);
      if (!norm) {
        failNorm++;
        if (failSamples.length < 12) {
          const d = digitsOnly(raw);
          failSamples.push(`len=${d.length} ${d.slice(0, 3)}…${d.slice(-2)}`);
        }
      } else {
        whaapyStrict.set(norm, (whaapyStrict.get(norm) ?? 0) + 1);
        const hit = shop.strict.get(norm);
        if (hit) {
          shouldLinkStrict++;
          if (hit.length > 1) ambiguousConflict++;
          else cleanLink++;
        }
      }
      if (l10 && shop.loose.has(l10)) {
        shouldLinkLoose++;
        if (!norm || !shop.strict.has(norm)) looseOnly++;
      }
    }
    if (!resp.pagination?.has_more || !resp.pagination?.next_cursor) break;
    cursor = resp.pagination.next_cursor;
  }

  const whaapyDupPhones = [...whaapyStrict.values()].filter((c) => c > 1).length;

  console.log("\n============================================================");
  console.log("WHAAPY SOURCE — cross-link audit");
  console.log("============================================================");
  console.log(`  Reported pagination.total .............. ${reportedTotal}`);
  console.log(`  Whaapy contacts scanned ................ ${total}`);
  console.log(`  No phone_number ........................ ${noPhone}`);
  console.log(`  >> Phone FAILS E.164 normalization ..... ${failNorm}`);
  if (failSamples.length) console.log(`     samples (shape only): ${failSamples.join(" | ")}`);
  console.log(`  Intra-Whaapy shared phones (dup) ....... ${whaapyDupPhones}`);
  console.log("\n  -- Cross-link with Shopify (the should-link pairs) --");
  console.log(`  >> Share a phone w/ Shopify (STRICT E164) ${shouldLinkStrict}`);
  console.log(`       · clean (matches exactly 1 cust) ... ${cleanLink}  <-- happy auto-link`);
  console.log(`       · ambiguous (matches >1 cust) ...... ${ambiguousConflict}  <-- conflict_create_new`);
  console.log(`  >> Share a phone w/ Shopify (LOOSE l10) . ${shouldLinkLoose}`);
  console.log(`       · matched LOOSE but NOT strict ..... ${looseOnly}  <-- normalization dropping links`);
  const pureLeads = total - noPhone - shouldLinkStrict;
  console.log(`\n  Whaapy contacts with NO Shopify match .. ~${pureLeads}  (import as pure leads — not dups)`);

  // -------- Reveal top Shopify placeholder (unmasked) --------
  const sharedShop = [...shop.strict.entries()].filter(([, arr]) => arr.length > 1).sort((a, b) => b[1].length - a[1].length);
  console.log("\n============================================================");
  console.log("SHOPIFY PLACEHOLDER REVEAL (top shared number, UNMASKED)");
  console.log("============================================================");
  if (sharedShop.length > 0) {
    const [ph, custs] = sharedShop[0];
    console.log(`  Number: ${ph}   (shared by ${custs.length} customers)`);
    for (const c of custs) {
      const gid = c.id.replace("gid://shopify/Customer/", "");
      console.log(`     - ${gid}  ${c.name ?? "(no name)"}`);
    }
    if (sharedShop.length > 1) {
      console.log(`  (other shared numbers, masked:)`);
      for (const [p, cs] of sharedShop.slice(1, 8)) console.log(`     ${maskPhone(p)} ×${cs.length}`);
    }
  } else {
    console.log("  (no shared numbers found)");
  }

  console.log("\n[done] read-only audit — no writes performed.\n");
}

main().catch((e: Error) => {
  console.error("AUDIT FAILED:", e.message);
  if ((e as unknown as { body?: unknown }).body) console.dir((e as unknown as { body: unknown }).body, { depth: 4 });
  process.exit(1);
});
