/* eslint-disable no-console */
/**
 * Audit READ-ONLY — disecciona los "loose-only" (whaapy contacts que
 * matchean Shopify por últimos-10-dígitos pero NO por E.164 estricto)
 * para decidir si el fallback last-10 recupera enlaces REALES o solo
 * colisiones coincidentes US↔MX. NO escribe nada.
 *
 * Para cada loose-only clasifica el número Whaapy por país:
 *   - realMxDrop: Whaapy es +52 válido; su +52+last10 cae en un customer
 *     Shopify → mismo número, perdido por forma legacy +521 → RECUPERABLE.
 *   - foreignCoincidence: Whaapy es +1/otro país; el last10 coincide con
 *     un MX de Shopify por azar → FALSO POSITIVO (no enlazar).
 *   - unparseableMx: Whaapy no normaliza pero forma MX y +52+last10 cae
 *     en Shopify → recuperable de baja confianza.
 *
 * Uso:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/whaapy/audit-loose-only.ts --org-slug centr
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { parsePhoneNumberFromString, type MetadataJson } from "libphonenumber-js/core";
import metadata from "libphonenumber-js/metadata.min.json";
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
const last10 = (s: string) => { const d = digitsOnly(s); return d.length >= 10 ? d.slice(-10) : null; };
function pickPhone(profile: string | null | undefined, addr: string | null | undefined): string | null {
  const p = (profile ?? "").trim(); if (p) return profile ?? null;
  const a = (addr ?? "").trim(); if (a) return addr ?? null;
  return null;
}
function countryOf(raw: string): string | null {
  try {
    const p = parsePhoneNumberFromString(raw, "MX", metadata as unknown as MetadataJson);
    return p?.country ?? null;
  } catch { return null; }
}

async function buildShop(opts: { organizationId: UUID; shopDomain: string }) {
  const meta = await shopifyGraphql<{ __type: { fields: Array<{ name: string }> } }>(
    opts, `{ __type(name:"Customer"){fields{name}} }`,
  );
  const names = new Set(meta.__type.fields.map((f) => f.name));
  const phoneSel = names.has("phone") ? "phone" : names.has("defaultPhoneNumber") ? "defaultPhoneNumber { phoneNumber }" : "";
  const q = `query($cursor:String){ customers(first:250, after:$cursor){ pageInfo{hasNextPage endCursor} edges{ node{ id ${phoneSel} defaultAddress{ phone } } } } }`;
  const strict = new Map<string, number>();
  const loose = new Map<string, Set<string>>();
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
      const l = last10(raw);
      if (l) { const s = loose.get(l) ?? new Set(); s.add(node.id); loose.set(l, s); }
    }
    if (!data.customers.pageInfo.hasNextPage) break;
    cursor = data.customers.pageInfo.endCursor;
  }
  return { strict, loose };
}

async function main() {
  const { orgSlug } = parseArgs();
  void getSupabaseAdminClient();
  const org = await getOrganizationBySlug(orgSlug);
  if (!org?.shopify_store_domain) throw new Error("centr sin shopify_store_domain");
  const shopOpts = { organizationId: org.id as UUID, shopDomain: org.shopify_store_domain };
  const whaapyCtx = { organizationId: org.id as UUID };

  const shop = await buildShop(shopOpts);
  console.log(`Shopify strict=${shop.strict.size} looseKeys=${shop.loose.size}`);

  let cursor: string | null = null;
  let looseOnly = 0;
  let realMxDrop = 0;
  let foreignCoincidence = 0;
  let unparseableMx = 0;
  let otherNoRecover = 0;
  const countryTally = new Map<string, number>();
  const realSamples: string[] = [];
  const rows: string[] = [];
  const mask = (e?: string | null) => (e && e.length > 6 ? e.slice(0, 3) + "*".repeat(e.length - 6) + e.slice(-3) : (e ?? "null"));

  for (;;) {
    const qs: string = `/contacts/v1?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const resp = await whaapyRest<{ contacts: Array<{ phone_number: string | null }>; pagination: { has_more: boolean; next_cursor: string | null } }>(
      whaapyCtx, "GET", qs,
    );
    for (const c of resp.contacts ?? []) {
      const raw = (c.phone_number ?? "").trim();
      if (!raw) continue;
      const norm = normalizePhone(raw, "MX");
      if (norm && shop.strict.has(norm)) continue; // strict-linked already
      const l = last10(raw);
      if (!l || !shop.loose.has(l)) continue;       // no loose overlap
      looseOnly++;
      const country = norm ? countryOf(raw) : (countryOf(raw) ?? "??");
      countryTally.set(country ?? "??", (countryTally.get(country ?? "??") ?? 0) + 1);
      const mxCand = normalizePhone("+52" + l, "MX");
      const mxLands = !!(mxCand && shop.strict.has(mxCand));
      const shopCustsOnL10 = shop.loose.get(l)?.size ?? 0;
      const shopStrictCount = mxCand ? (shop.strict.get(mxCand) ?? 0) : 0;
      rows.push(
        `whaapy[${country ?? "??"}] norm=${mask(norm)} l10=…${l.slice(-4)} ` +
        `| shopCustsSharingL10=${shopCustsOnL10} shopStrictOnMxCand=${shopStrictCount} ` +
        `| mxCand=${mask(mxCand)}`,
      );
      if (norm && norm.startsWith("+52") && mxLands) {
        realMxDrop++;
        if (realSamples.length < 8) realSamples.push(`whaapyNorm=${norm} -> mxCand=${mxCand}`);
      } else if (norm && !norm.startsWith("+52")) {
        foreignCoincidence++;
      } else if (!norm && mxLands) {
        unparseableMx++;
      } else {
        otherNoRecover++;
      }
    }
    if (!resp.pagination?.has_more || !resp.pagination?.next_cursor) break;
    cursor = resp.pagination.next_cursor;
  }

  console.log("\n============================================================");
  console.log("LOOSE-ONLY DISSECTION (would the last-10 fallback link REAL pairs?)");
  console.log("============================================================");
  console.log(`  Loose-only total ....................... ${looseOnly}`);
  console.log(`  >> realMxDrop (SAME MX number, legacy form) ${realMxDrop}  <-- real links the fallback recovers`);
  console.log(`  >> unparseableMx (MX shape, recovers) .. ${unparseableMx}  <-- low-confidence recover`);
  console.log(`  foreignCoincidence (US/other ×MX by luck) ${foreignCoincidence}  <-- FALSE POSITIVES to avoid`);
  console.log(`  otherNoRecover ......................... ${otherNoRecover}`);
  console.log("\n  Whaapy-side country of loose-only matches:");
  for (const [cc, n] of Array.from(countryTally.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${cc}: ${n}`);
  }
  if (realSamples.length) {
    console.log("\n  realMxDrop samples:");
    for (const s of realSamples) console.log(`     ${s}`);
  }
  console.log("\n  Per-row detail of all loose-only (masked):");
  for (const r of rows) console.log(`     ${r}`);
  console.log("\n[done] read-only audit — no writes performed.\n");
}

main().catch((e: Error) => {
  console.error("AUDIT FAILED:", e.message);
  if ((e as unknown as { body?: unknown }).body) console.dir((e as unknown as { body: unknown }).body, { depth: 4 });
  process.exit(1);
});
