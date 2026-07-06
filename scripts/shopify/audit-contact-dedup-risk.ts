/* eslint-disable no-console */
/**
 * Audit READ-ONLY — cuantifica el riesgo de duplicados de CONTACTO para
 * el backfill masivo. NO escribe nada. Dos mitades:
 *
 *  A) Fuente Shopify (todos los customers vía GraphQL cursor):
 *     - customers cuyo teléfono NO normaliza a E.164 (blast de la
 *       falla de normalización → duplicados humanos no enlazables).
 *     - customers sin teléfono NI email (sin identificador fuerte).
 *     - teléfonos compartidos / placeholder (cuántos customers comparten
 *       un mismo número normalizado → conflict_create_new / falso link).
 *
 *  B) Tabla `contacts` actual (lo ya importado): mismas métricas sobre
 *     el estado presente + leads/clientes.
 *
 * Usa el MISMO `normalizePhone` (libphonenumber-js MX) y la misma
 * precedencia de teléfono (perfil → default_address.phone) que el
 * backfill, para fidelidad. Valores sensibles enmascarados en salida.
 *
 * Uso:
 *   npx tsx scripts/shopify/audit-contact-dedup-risk.ts --org-slug centr
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { shopifyGraphql } from "@/lib/shopify/admin-client";
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

// Precedencia idéntica a pickCustomerPhone del mapper: perfil primero,
// si vacío/ausente cae a default_address.phone.
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

function isPlaceholderRaw(raw: string): boolean {
  const d = digitsOnly(raw);
  if (d.length === 0) return true;
  if (d.length < 7) return true;              // muy corto para ser real
  if (/^(\d)\1+$/.test(d)) return true;        // todos el mismo dígito
  if (/^0+$/.test(d)) return true;
  if ("1234567890".includes(d) || "0123456789".includes(d)) return true;
  if ("0987654321".includes(d)) return true;
  return false;
}

function maskPhone(e164: string): string {
  if (e164.length <= 5) return "***";
  return e164.slice(0, 3) + "*".repeat(Math.max(0, e164.length - 7)) + e164.slice(-4);
}

async function introspectFields(opts: { organizationId: UUID; shopDomain: string }) {
  const q = `{
    __type(name: "Customer") { fields { name } }
    shop { name myshopifyDomain }
    customersCount { count }
  }`;
  const data = await shopifyGraphql<{
    __type: { fields: Array<{ name: string }> };
    shop: { name: string; myshopifyDomain: string };
    customersCount: { count: number };
  }>(opts, q);
  const names = new Set(data.__type.fields.map((f) => f.name));
  return {
    shopName: data.shop?.name,
    shopDomain: data.shop?.myshopifyDomain,
    totalCount: data.customersCount?.count ?? null,
    hasPhone: names.has("phone"),
    hasDefaultPhoneNumber: names.has("defaultPhoneNumber"),
    hasEmail: names.has("email"),
    hasDefaultEmailAddress: names.has("defaultEmailAddress"),
    hasNumberOfOrders: names.has("numberOfOrders"),
  };
}

interface CustomerNode {
  id: string;
  email?: string | null;
  phone?: string | null;
  defaultEmailAddress?: { emailAddress?: string | null } | null;
  defaultPhoneNumber?: { phoneNumber?: string | null } | null;
  defaultAddress?: { phone?: string | null } | null;
  numberOfOrders?: string | null;
}

async function auditShopifySource(opts: { organizationId: UUID; shopDomain: string }) {
  const f = await introspectFields(opts);
  console.log("\n============================================================");
  console.log(`SHOPIFY SOURCE — ${f.shopName} (${f.shopDomain})`);
  console.log(`Reported customersCount: ${f.totalCount}`);
  console.log("============================================================");

  const emailSel = f.hasEmail ? "email" : f.hasDefaultEmailAddress ? "defaultEmailAddress { emailAddress }" : "";
  const phoneSel = f.hasPhone ? "phone" : f.hasDefaultPhoneNumber ? "defaultPhoneNumber { phoneNumber }" : "";
  const ordersSel = f.hasNumberOfOrders ? "numberOfOrders" : "";
  console.log(`Field selection → email:[${emailSel || "NONE"}] phone:[${phoneSel || "NONE"}] orders:[${ordersSel || "NONE"}]`);

  const query = `query Audit($cursor: String) {
    customers(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id
        ${emailSel}
        ${phoneSel}
        ${ordersSel}
        defaultAddress { phone }
      } }
    }
  }`;

  let cursor: string | null = null;
  let scanned = 0;
  let withRawPhone = 0;
  let phoneFailsNormalize = 0;
  let noPhoneAtAll = 0;
  let noEmail = 0;
  let noPhoneNoEmail = 0;
  let placeholderRaw = 0;
  let withOrders = 0;
  const normFreq = new Map<string, number>();
  const failSamples: string[] = [];

  for (;;) {
    const data: {
      customers: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        edges: Array<{ node: CustomerNode }>;
      };
    } = await shopifyGraphql(opts, query, { cursor });
    for (const { node } of data.customers.edges) {
      scanned++;
      const email = node.email ?? node.defaultEmailAddress?.emailAddress ?? null;
      const profilePhone = node.phone ?? node.defaultPhoneNumber?.phoneNumber ?? null;
      const rawPhone = pickPhone(profilePhone, node.defaultAddress?.phone ?? null);
      const orders = node.numberOfOrders ? Number(node.numberOfOrders) : 0;
      if (orders > 0) withOrders++;

      const hasEmail = !!(email && email.trim());
      if (!hasEmail) noEmail++;

      if (!rawPhone) {
        noPhoneAtAll++;
        if (!hasEmail) noPhoneNoEmail++;
        continue;
      }
      withRawPhone++;
      if (isPlaceholderRaw(rawPhone)) placeholderRaw++;
      const norm = normalizePhone(rawPhone, "MX");
      if (!norm) {
        phoneFailsNormalize++;
        if (failSamples.length < 12) {
          const d = digitsOnly(rawPhone);
          failSamples.push(`len=${d.length} pattern=${d.slice(0, 2)}…${d.slice(-2)}`);
        }
        continue;
      }
      normFreq.set(norm, (normFreq.get(norm) ?? 0) + 1);
    }
    if (!data.customers.pageInfo.hasNextPage) break;
    cursor = data.customers.pageInfo.endCursor;
    if (scanned % 1000 === 0) console.log(`  …scanned ${scanned}`);
  }

  // Teléfonos compartidos (mismo E.164 en >1 customer).
  const shared = [...normFreq.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
  const customersInShared = shared.reduce((acc, [, c]) => acc + c, 0);

  console.log(`\n  Total customers scanned .................. ${scanned}`);
  console.log(`  With a usable raw phone ................. ${withRawPhone}`);
  console.log(`  >> Phone present but FAILS E.164 norm ... ${phoneFailsNormalize}  <-- unlinkable-by-phone`);
  console.log(`     (raw looked like a placeholder) ...... ${placeholderRaw}`);
  console.log(`  No phone at all ........................ ${noPhoneAtAll}`);
  console.log(`  No email ............................... ${noEmail}`);
  console.log(`  >> Neither phone NOR email ............. ${noPhoneNoEmail}  <-- never cross-linkable`);
  console.log(`  Has >=1 order .......................... ${withOrders}`);
  console.log(`\n  Distinct normalized phones ............. ${normFreq.size}`);
  console.log(`  >> Normalized phones SHARED by >1 cust . ${shared.length}  <-- conflict_create_new risk`);
  console.log(`  >> Customers involved in a shared phone  ${customersInShared}`);
  if (shared.length > 0) {
    console.log(`  Top shared normalized numbers (masked):`);
    for (const [ph, c] of shared.slice(0, 15)) {
      const flag = isPlaceholderRaw(ph) ? " [PLACEHOLDER?]" : "";
      console.log(`     ${maskPhone(ph)}  ×${c}${flag}`);
    }
  }
  if (failSamples.length > 0) {
    console.log(`  Fail-to-normalize samples (shape only): ${failSamples.join(" | ")}`);
  }
}

async function auditContactsTable(organizationId: UUID) {
  const admin = getSupabaseAdminClient();
  console.log("\n============================================================");
  console.log("PLATFORM `contacts` TABLE — current state (already imported)");
  console.log("============================================================");

  let from = 0;
  const page = 1000;
  let total = 0;
  let clientes = 0;
  let leads = 0;
  let phoneNull = 0;
  let emailNull = 0;
  let bothNull = 0;
  let missingPhoneFlag = 0;
  let leadWithPhone = 0;
  const phoneFreq = new Map<string, number>();

  for (;;) {
    const { data, error } = await admin
      .from("contacts")
      .select("phone, email, shopify_customer_id, whaapy_contact_id, missing_phone")
      .eq("organization_id", organizationId)
      .range(from, from + page - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{
      phone: string | null;
      email: string | null;
      shopify_customer_id: string | null;
      whaapy_contact_id: string | null;
      missing_phone: boolean;
    }>;
    for (const r of rows) {
      total++;
      if (r.shopify_customer_id) clientes++;
      else leads++;
      const hasPhone = !!(r.phone && r.phone.trim());
      const hasEmail = !!(r.email && r.email.trim());
      if (!hasPhone) phoneNull++;
      if (!hasEmail) emailNull++;
      if (!hasPhone && !hasEmail) bothNull++;
      if (r.missing_phone) missingPhoneFlag++;
      if (!r.shopify_customer_id && hasPhone) leadWithPhone++;
      if (hasPhone) phoneFreq.set(r.phone as string, (phoneFreq.get(r.phone as string) ?? 0) + 1);
    }
    if (rows.length < page) break;
    from += page;
  }

  const shared = [...phoneFreq.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
  const contactsInShared = shared.reduce((acc, [, c]) => acc + c, 0);

  console.log(`\n  Total contacts ......................... ${total}`);
  console.log(`    clientes (has shopify_customer_id) ... ${clientes}`);
  console.log(`    leads (no shopify_customer_id) ....... ${leads}`);
  console.log(`      of which leads WITH a phone ........ ${leadWithPhone}  (phone-linkable to a future Shopify cust)`);
  console.log(`  phone IS NULL .......................... ${phoneNull}`);
  console.log(`  email IS NULL .......................... ${emailNull}`);
  console.log(`  >> BOTH null (no strong identifier) .... ${bothNull}`);
  console.log(`  missing_phone flag = true .............. ${missingPhoneFlag}`);
  console.log(`\n  Distinct non-null phones ............... ${phoneFreq.size}`);
  console.log(`  >> Phones SHARED by >1 contact ......... ${shared.length}  <-- existing collisions`);
  console.log(`  >> Contacts involved in a shared phone . ${contactsInShared}`);
  if (shared.length > 0) {
    console.log(`  Top shared phones in contacts (masked):`);
    for (const [ph, c] of shared.slice(0, 15)) {
      console.log(`     ${maskPhone(ph)}  ×${c}`);
    }
  }
}

async function main() {
  const { orgSlug } = parseArgs();
  void getSupabaseAdminClient();
  const org = await getOrganizationBySlug(orgSlug);
  if (!org) throw new Error(`org ${orgSlug} no encontrada`);
  if (!org.shopify_store_domain) throw new Error(`org ${orgSlug} sin shopify_store_domain`);
  const opts = { organizationId: org.id as UUID, shopDomain: org.shopify_store_domain };

  await auditShopifySource(opts);
  await auditContactsTable(org.id as UUID);
  console.log("\n[done] read-only audit — no writes performed.\n");
}

main().catch((e: Error) => {
  console.error("AUDIT FAILED:", e.message);
  process.exit(1);
});
