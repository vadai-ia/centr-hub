/* eslint-disable no-console */
/**
 * Script de diagnóstico: imprimir el valor CRUDO de los campos de
 * teléfono que devuelve Shopify para un customer específico, sin
 * normalizar ni transformar. Herramienta de lectura permanente —
 * mismo patrón que `scripts/whaapy/inspect-get-contact.ts`.
 *
 * Motivo de existencia: cuando `normalizePhone` rechaza un teléfono
 * silenciosamente (devuelve null), el síntoma en BD es indistinguible
 * de "Shopify no tiene teléfono". Esta herramienta permite capturar
 * el string EXACTO (incluyendo whitespace, caracteres invisibles, y
 * prefijos legacy) para diagnosticar por qué libphonenumber-js lo
 * descarta. También aplica para investigar cualquier otro campo del
 * customer que aparezca null/inesperado en BD pero presente en
 * Shopify Admin.
 *
 * Uso:
 *   npm run shopify:inspect-get-customer -- \
 *       --org-slug centr \
 *       --customer-id 9759438635284
 *
 * Output:
 *   - HTTP status del GET.
 *   - JSON crudo (primeros 6000 chars).
 *   - Valores literales de:
 *       * customer.phone (top-level)
 *       * customer.default_address.phone
 *       * customer.first_name, last_name, email (sanity check)
 *   - Representación hex de cada phone para detectar caracteres
 *     invisibles (BOM, NBSP, ZWSP, etc.) que `trim()` no remueve.
 *   - Resultado de `normalizePhone(_, "MX")` aplicado a cada phone
 *     candidato, para identificar qué string rompe la normalización.
 *
 * NO escribe nada en BD. NO modifica el contact. Es una lectura pura.
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { shopifyRest } from "@/lib/shopify/admin-client";
import { normalizePhone } from "@/lib/services/identity-matching";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

interface CliArgs {
  orgSlug: string;
  customerId: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let orgSlug: string | null = null;
  let customerId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (arg === "--customer-id") customerId = argv[++i] ?? null;
  }
  if (!orgSlug || !customerId) {
    console.error(
      "Uso: tsx inspect-get-customer.ts --org-slug <slug> --customer-id <shopify_customer_id>",
    );
    process.exit(2);
  }
  return { orgSlug, customerId };
}

function toHex(value: unknown): string {
  if (typeof value !== "string") return "(no es string)";
  return Array.from(value)
    .map((ch) => {
      const cp = ch.codePointAt(0);
      if (cp === undefined) return "??";
      return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}(${ch === " " ? "SPACE" : ch})`;
    })
    .join(" ");
}

function describePhoneCandidate(label: string, raw: unknown): void {
  console.log(`\n  ${label}:`);
  console.log(`    typeof:           ${typeof raw}`);
  console.log(`    valor literal:    ${JSON.stringify(raw)}`);
  if (typeof raw === "string") {
    console.log(`    length:           ${raw.length}`);
    console.log(`    trimmed length:   ${raw.trim().length}`);
    console.log(`    hex (codepoints): ${toHex(raw)}`);
    const normalized = normalizePhone(raw, "MX");
    console.log(`    normalizePhone:   ${normalized === null ? "null (RECHAZADO por libphonenumber)" : normalized}`);
  } else if (raw === null) {
    console.log(`    (Shopify devolvió null explícito)`);
  } else if (raw === undefined) {
    console.log(`    (campo ausente del payload)`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  void getSupabaseAdminClient(); // forzar init temprano
  const org = await getOrganizationBySlug(args.orgSlug);
  if (!org) {
    console.error(`org ${args.orgSlug} no encontrada`);
    process.exit(1);
  }
  if (!org.shopify_store_domain) {
    console.error(`org ${args.orgSlug} no tiene shopify_store_domain`);
    process.exit(1);
  }

  console.log(`org:               ${org.name} (${org.id})`);
  console.log(`shop_domain:       ${org.shopify_store_domain}`);
  console.log(`shopify customer:  ${args.customerId}`);

  const ctx = {
    organizationId: org.id as UUID,
    shopDomain: org.shopify_store_domain,
  };

  // El cliente Shopify requiere tenant context (lee Client ID/Secret
  // y access_token cacheado desde el Vault de la org).
  const res = await withTenantContext(
    ctx.organizationId,
    async () => {
      return shopifyRest<{ customer: unknown }>(
        ctx,
        "GET",
        `/customers/${args.customerId}.json`,
      );
    },
    { source: "script" },
  );

  const customer = res?.customer as Record<string, unknown> | null | undefined;
  if (!customer) {
    console.log("\nShopify devolvió un payload sin `customer` top-level.");
    console.log("--- raw response ---");
    console.dir(res, { depth: null });
    return;
  }

  console.log("\n--- Customer payload (pretty, depth=null) ---");
  console.dir(customer, { depth: null });

  console.log("\n--- Sanity check (identidad) ---");
  console.log(`  id:           ${customer.id}`);
  console.log(`  first_name:   ${JSON.stringify(customer.first_name)}`);
  console.log(`  last_name:    ${JSON.stringify(customer.last_name)}`);
  console.log(`  email:        ${JSON.stringify(customer.email)}`);

  console.log("\n--- TELÉFONOS (valor CRUDO, sin normalizar) ---");
  describePhoneCandidate("customer.phone (top-level)", customer.phone);

  const defaultAddress = customer.default_address as
    | Record<string, unknown>
    | null
    | undefined;
  if (defaultAddress) {
    describePhoneCandidate(
      "customer.default_address.phone",
      defaultAddress.phone,
    );
  } else {
    console.log("\n  customer.default_address:");
    console.log(`    (Shopify devolvió ${defaultAddress === null ? "null" : "campo ausente"})`);
  }

  // El customer también puede tener un array `addresses` con phones
  // alternativos. Útil cuando el default_address está vacío pero hay
  // otra dirección con phone.
  const addresses = customer.addresses as
    | Array<Record<string, unknown>>
    | null
    | undefined;
  if (Array.isArray(addresses) && addresses.length > 0) {
    console.log(`\n--- customer.addresses[] (${addresses.length} direcciones) ---`);
    addresses.forEach((addr, i) => {
      describePhoneCandidate(`customer.addresses[${i}].phone`, addr.phone);
    });
  } else {
    console.log("\n  customer.addresses: (vacío o ausente)");
  }

  console.log("\n===== fin =====");
}

main().catch((err: Error) => {
  console.error("inspect-get-customer falló:", err.message);
  if ((err as unknown as { body?: unknown }).body) {
    console.dir((err as unknown as { body: unknown }).body, { depth: null });
  }
  process.exit(1);
});
