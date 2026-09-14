/* eslint-disable no-console */
/**
 * Correctivo de una sola vez: fusiona los LEADS duplicados que ya existen
 * dentro de su CLIENTE de Shopify (0054).
 *
 * El worker de `customers/update` ya previene los duplicados nuevos: cuando un
 * cliente recibe teléfono, busca el lead con ese número y lo fusiona. Esto
 * limpia los que se crearon ANTES del arreglo. Aplica exactamente la misma
 * decisión (`decideLeadClientMerge`) y el mismo RPC atómico que el worker, así
 * que un par que el script fusiona es un par que el worker habría fusionado.
 *
 * DRY-RUN POR DEFECTO: lista los pares y cuántas filas movería, sin escribir.
 * `--apply` fusiona. Cada fusión deja audit `contact_lead_merged_into_client`
 * con la foto completa del lead, para poder reconstruirlo.
 *
 * Uso:
 *   npm run maintenance:merge-duplicate-leads -- --org-slug centr
 *   npm run maintenance:merge-duplicate-leads -- --org-slug centr --apply
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import { fetchAllPaged } from "@/lib/db/paginate";
import { mergeDuplicateLeadIntoClient } from "@/lib/services/contact-lead-merge";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

interface Row {
  id: string;
  full_name: string | null;
  phone: string | null;
  shopify_customer_id: string | null;
}

async function main() {
  const argv = process.argv.slice(2);
  let orgSlug: string | null = null;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--apply") apply = true;
  }
  if (!orgSlug) {
    console.error("Uso: tsx merge-duplicate-leads.ts --org-slug <slug> [--apply]");
    process.exit(2);
  }
  const org = await getOrganizationBySlug(orgSlug);
  if (!org) {
    console.error(`No existe la organización "${orgSlug}".`);
    process.exit(1);
  }

  console.log(`\n=== FUSIÓN DE LEADS DUPLICADOS (org=${orgSlug}) ===`);
  console.log(apply ? "MODO: APLICAR (escribe)\n" : "MODO: dry-run (no escribe)\n");

  await withTenantContext(
    org.id,
    async () => {
      const { supabase, organizationId } = getTenantScopedClient();
      const rows = await fetchAllPaged<Row>(() =>
        supabase
          .from("contacts")
          .select("id, full_name, phone, shopify_customer_id")
          .eq("organization_id", organizationId)
          .not("phone", "is", null)
          .is("anonymized_at", null),
      );

      // Clientes cuyo teléfono comparten con al menos un lead. La decisión fina
      // (único lead, nombres compatibles, sin choque de Whaapy) la toma el
      // servicio: aquí solo se eligen candidatos.
      const byPhone = new Map<string, Row[]>();
      for (const r of rows) byPhone.set(r.phone!, [...(byPhone.get(r.phone!) ?? []), r]);
      const candidates = Array.from(byPhone.values())
        .filter((g) => g.some((r) => r.shopify_customer_id) && g.some((r) => !r.shopify_customer_id))
        .flatMap((g) => g.filter((r) => r.shopify_customer_id));

      const nameById = new Map(rows.map((r) => [r.id, r.full_name ?? "(sin nombre)"]));
      const tally = new Map<string, number>();
      for (const c of candidates) {
        const res = await mergeDuplicateLeadIntoClient(c.id, {
          dryRun: !apply,
          trigger: "corrective_script",
        });
        const key = res.status === "skipped" ? `omitido:${res.reason}` : res.status;
        tally.set(key, (tally.get(key) ?? 0) + 1);
        const lead = res.leadContactId ? nameById.get(res.leadContactId) : "—";
        console.log(
          `  ${res.status.padEnd(11)} cliente="${nameById.get(c.id)}" lead="${lead}"` +
            (res.reason ? ` motivo=${res.reason}` : "") +
            (res.moved ? ` filas=${JSON.stringify(res.moved)}` : "") +
            (res.absorbedOpportunityIds.length ? ` leads_archivados=${res.absorbedOpportunityIds.length}` : ""),
        );
      }

      console.log(`\nCandidatos: ${candidates.length}`);
      for (const [k, n] of Array.from(tally)) console.log(`  ${k.padEnd(34)} ${n}`);
      if (!apply) console.log("\nDry-run: no se escribió nada. Agrega --apply para fusionar.\n");
    },
    { source: "script" },
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
