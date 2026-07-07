/* eslint-disable no-console */
/**
 * Audit READ-ONLY — cuantifica cuántas de las fallas de normalización de
 * Whaapy son números MEXICANOS recuperables (retry con +52 / strip del 1
 * legacy) y cuántas recuperan un enlace con Shopify. NO escribe nada.
 *
 * Solo trata como "MX recuperable" si la FORMA original de dígitos es
 * mexicana (10 dígitos; 1+10 legacy; 52+10; 521+10). Así un número
 * foráneo (UK 44…, etc.) NO se fuerza a un +52 falso-válido.
 *
 * Uso:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/whaapy/audit-whaapy-recovery.ts --org-slug centr
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
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? "centr";
  return { orgSlug };
}
const digitsOnly = (s: string) => s.replace(/\D/g, "");
function pickPhone(profile: string | null | undefined, addr: string | null | undefined): string | null {
  const p = (profile ?? "").trim(); if (p) return profile ?? null;
  const a = (addr ?? "").trim(); if (a) return addr ?? null;
  return null;
}

type MxShape = "mx10" | "mx11_1" | "mx12_52" | "mx13_521" | "foreign" | "short";
function classifyMx(raw: string): { shape: MxShape; recovered: string | null } {
  const d = digitsOnly(raw);
  if (d.length < 10) return { shape: "short", recovered: null };
  let shape: MxShape;
  if (d.length === 10) shape = "mx10";
  else if (d.length === 11 && d.startsWith("1")) shape = "mx11_1";
  else if (d.length === 12 && d.startsWith("52")) shape = "mx12_52";
  else if (d.length === 13 && d.startsWith("521")) shape = "mx13_521";
  else shape = "foreign";
  if (shape === "foreign") return { shape, recovered: null };
  const cand = "+52" + d.slice(-10);
  return { shape, recovered: normalizePhone(cand, "MX") };
}

async function buildShopifyStrict(opts: { organizationId: UUID; shopDomain: string }) {
  const meta = await shopifyGraphql<{ __type: { fields: Array<{ name: string }> } }>(
    opts, `{ __type(name:"Customer"){fields{name}} }`,
  );
  const names = new Set(meta.__type.fields.map((f) => f.name));
  const phoneSel = names.has("phone") ? "phone" : names.has("defaultPhoneNumber") ? "defaultPhoneNumber { phoneNumber }" : "";
  const q = `query($cursor:String){ customers(first:250, after:$cursor){ pageInfo{hasNextPage endCursor} edges{ node{ id ${phoneSel} defaultAddress{ phone } } } } }`;
  const strict = new Map<string, number>();
  let cursor: string | null = null;
  for (;;) {
    const data: { customers: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: Array<{ node: {
      id: string; phone?: string | null; defaultPhoneNumber?: { phoneNumber?: string | null } | null; defaultAddress?: { phone?: string | null } | null;
    } }> } } = await shopifyGraphql(opts, q, { cursor });
    for (const { node } of data.customers.edges) {
      const raw = pickPhone(node.phone ?? node.defaultPhoneNumber?.phoneNumber ?? null, node.defaultAddress?.phone ?? null);
      if (!raw) continue;
      const n = normalizePhone(raw, "MX");
      if (n) strict.set(n, (strict.get(n) ?? 0) + 1);
    }
    if (!data.customers.pageInfo.hasNextPage) break;
    cursor = data.customers.pageInfo.endCursor;
  }
  return strict;
}

async function main() {
  const { orgSlug } = parseArgs();
  void getSupabaseAdminClient();
  const org = await getOrganizationBySlug(orgSlug);
  if (!org?.shopify_store_domain) throw new Error("centr sin shopify_store_domain");
  const shopOpts = { organizationId: org.id as UUID, shopDomain: org.shopify_store_domain };
  const whaapyCtx = { organizationId: org.id as UUID };

  console.log("Building Shopify strict E.164 index…");
  const shopStrict = await buildShopifyStrict(shopOpts);
  console.log(`  distinct Shopify E.164: ${shopStrict.size}`);

  console.log("\nScanning Whaapy contacts for normalization failures…");
  let cursor: string | null = null;
  let scanned = 0;
  let failTotal = 0;
  const byShape: Record<MxShape, number> = { mx10: 0, mx11_1: 0, mx12_52: 0, mx13_521: 0, foreign: 0, short: 0 };
  let recovered = 0;              // failed strict but recovers to valid MX E.164
  let recoveredMatchClean = 0;    // recovered AND matches exactly 1 Shopify customer
  let recoveredMatchAmbig = 0;    // recovered AND matches >1 Shopify customer
  let recoveredNoMatch = 0;       // recovered but no Shopify counterpart (still becomes usable phone)
  let recoveredMx11NoMatch = 0;   // subset: legacy 1+10 with no Shopify match (US/MX ambiguous)
  const foreignSamples: string[] = [];

  for (;;) {
    const qs: string = `/contacts/v1?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const resp = await whaapyRest<{ contacts: Array<{ phone_number: string | null }>; pagination: { has_more: boolean; next_cursor: string | null } }>(
      whaapyCtx, "GET", qs,
    );
    for (const c of resp.contacts ?? []) {
      scanned++;
      const raw = (c.phone_number ?? "").trim();
      if (!raw) continue;
      if (normalizePhone(raw, "MX")) continue; // strict OK — not a failure
      failTotal++;
      const { shape, recovered: rec } = classifyMx(raw);
      byShape[shape]++;
      if (shape === "foreign" && foreignSamples.length < 10) {
        const d = digitsOnly(raw);
        foreignSamples.push(`len=${d.length} ${d.slice(0, 3)}…`);
      }
      if (rec) {
        recovered++;
        const hit = shopStrict.get(rec);
        if (hit && hit > 1) recoveredMatchAmbig++;
        else if (hit === 1) recoveredMatchClean++;
        else {
          recoveredNoMatch++;
          if (shape === "mx11_1") recoveredMx11NoMatch++;
        }
      }
    }
    if (!resp.pagination?.has_more || !resp.pagination?.next_cursor) break;
    cursor = resp.pagination.next_cursor;
  }

  console.log("\n============================================================");
  console.log("328-FAILURE RECOVERY BREAKDOWN");
  console.log("============================================================");
  console.log(`  Whaapy contacts scanned ................ ${scanned}`);
  console.log(`  Strict E.164 failures (total) .......... ${failTotal}`);
  console.log("\n  By original digit shape:");
  console.log(`    mx10   (10 digits) ................... ${byShape.mx10}`);
  console.log(`    mx11_1 (1 + 10, legacy/US-ambig) ..... ${byShape.mx11_1}`);
  console.log(`    mx12_52(52 + 10) ..................... ${byShape.mx12_52}`);
  console.log(`    mx13_521(521 + 10) ................... ${byShape.mx13_521}`);
  console.log(`    foreign (non-MX shape) ............... ${byShape.foreign}`);
  console.log(`    short   (<10 digits, junk) ........... ${byShape.short}`);
  console.log("\n  Recovery (retry +52 on last-10, MX-shaped only):");
  console.log(`  >> RECOVERABLE to valid MX E.164 ....... ${recovered}`);
  console.log(`       · matches Shopify — clean (1 cust) . ${recoveredMatchClean}  <-- NEW LINKS from this bucket`);
  console.log(`       · matches Shopify — ambiguous (>1) . ${recoveredMatchAmbig}`);
  console.log(`       · no Shopify match (usable phone) .. ${recoveredNoMatch}`);
  console.log(`          of which legacy 1+10 no-match ... ${recoveredMx11NoMatch}  (US/MX ambiguous — low confidence)`);
  const unrecoverable = failTotal - recovered;
  console.log(`  >> NOT recoverable (foreign/junk) ...... ${unrecoverable}`);
  if (foreignSamples.length) console.log(`     foreign samples (shape only): ${foreignSamples.join(" | ")}`);
  console.log("\n[done] read-only audit — no writes performed.\n");
}

main().catch((e: Error) => {
  console.error("AUDIT FAILED:", e.message);
  if ((e as unknown as { body?: unknown }).body) console.dir((e as unknown as { body: unknown }).body, { depth: 4 });
  process.exit(1);
});
