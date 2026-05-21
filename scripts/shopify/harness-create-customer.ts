/* eslint-disable no-console */
/**
 * Harness de prueba manual — invoca `createCustomer` outbound a
 * Shopify desde el cliente outbound de M3.
 *
 * Propósito (checklist M3 #13): validar que la capacidad expuesta
 * para M6 funciona end-to-end sin construir la UI todavía. Crea
 * un contacto local sin shopify_customer_id, llama al outbound,
 * y verifica que el `shopify_customer_id` queda enlazado.
 *
 * Uso:
 *   npx tsx scripts/shopify/harness-create-customer.ts \
 *       --org-slug centr --phone +52155512345678 \
 *       --first-name TestM3 --last-name Harness --email test@m3.local
 *
 * El contact local se crea para que la marca outbound (R11) tenga
 * una fila donde escribir. Si --contact-id se pasa, reutiliza ese
 * contacto en lugar de crear uno.
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { createContact, getContactById } from "@/lib/db/contacts";
import { createCustomer } from "@/lib/shopify/outbound";
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
  if (!out["org-slug"] || !out.phone) {
    console.error(
      "Uso: tsx harness-create-customer.ts --org-slug <s> --phone <e164> [--first-name X --last-name Y --email z --contact-id uuid]",
    );
    process.exit(2);
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const org = await getOrganizationBySlug(args["org-slug"]);
  if (!org) {
    console.error(`org ${args["org-slug"]} no encontrada`);
    process.exit(1);
  }
  if (!org.shopify_store_domain) {
    console.error(`org ${args["org-slug"]} no tiene shopify_store_domain`);
    process.exit(1);
  }

  await withTenantContext(
    org.id as UUID,
    async () => {
      let contactId: UUID;
      if (args["contact-id"]) {
        const existing = await getContactById(args["contact-id"] as UUID);
        if (!existing) {
          console.error(`contact ${args["contact-id"]} no encontrado`);
          process.exit(1);
        }
        contactId = existing.id;
      } else {
        const fullName = [args["first-name"], args["last-name"]]
          .filter((s) => s && s.trim())
          .join(" ")
          .trim();
        const created = await createContact({
          full_name: fullName.length > 0 ? fullName : null,
          email: args.email ?? null,
          phone: args.phone,
          address: null,
          internal_note: "[harness] creado por harness-create-customer.ts",
          shopify_state: null,
          shopify_tags: [],
          assigned_advisor_id: null,
          shopify_customer_id: null,
          whaapy_contact_id: null,
          missing_phone: false,
          field_metadata: {},
          last_modified_at: new Date().toISOString(),
          last_modified_source: "platform",
          deleted_in_shopify: false,
          deleted_in_whaapy: false,
          anonymized_at: null,
        });
        contactId = created.id;
        console.log(`Contacto local creado: ${contactId}`);
      }

      const result = await createCustomer({
        ctx: { organizationId: org.id as UUID, shopDomain: org.shopify_store_domain! },
        contactId,
        fields: {
          first_name: args["first-name"] ?? null,
          last_name: args["last-name"] ?? null,
          email: args.email ?? null,
          phone: args.phone,
        },
      });
      console.log("createCustomer outbound result:", result);
    },
    { source: "script" },
  );
}

main().catch((err: Error) => {
  console.error("harness falló:", err.message);
  process.exit(1);
});
