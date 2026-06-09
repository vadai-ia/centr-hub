/* eslint-disable no-console */
/**
 * Correctivo (Fix A) — completa el archivado de los contactos que
 * quedaron a medias: `deleted_in_whaapy = true` pero con la
 * propagación incompleta (opp/lead aún activo, customer Shopify sin
 * etiquetar, badge contradictorio).
 *
 * Reusa EXACTAMENTE el mismo servicio que el worker en vivo
 * (`archiveContactForWhaapyDeletion`) — el correctivo no reimplementa
 * la lógica, sólo la aplica al histórico. Semántica idéntica:
 *   - cancela solo opps NO terminales (Ganada/Perdida se preservan),
 *   - etiqueta el customer Shopify (no borra),
 *   - el badge se corrige solo por derivación una vez deleted_in_whaapy
 *     queda consistente (ya lo está; el correctivo cierra el resto).
 *
 * Idempotente: `cancelOpportunity` preserva el primer `cancelled_at`,
 * el tag se de-duplica. Re-correr no toca lo ya completado.
 *
 * Uso:
 *   # Dry-run (no escribe — lista el plan):
 *   npm run maintenance:archive-whaapy-deleted-contacts -- --org-slug centr --dry-run
 *
 *   # Vivo:
 *   npm run maintenance:archive-whaapy-deleted-contacts -- --org-slug centr
 *
 *   # Tope defensivo (espera ~5; aborta si encuentra más):
 *   npm run maintenance:archive-whaapy-deleted-contacts -- --org-slug centr --expected-max 10
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import { archiveContactForWhaapyDeletion } from "@/lib/services/whaapy-contact-archival";
import type { ContactRow, UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

interface Args {
  orgSlug: string;
  dryRun: boolean;
  expectedMax: number;
}

function parseArgs(): Args {
  let orgSlug: string | null = null;
  let dryRun = false;
  let expectedMax = 25;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--expected-max") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) expectedMax = n;
    }
  }
  if (!orgSlug) {
    console.error(
      "Uso: tsx archive-whaapy-deleted-contacts.ts --org-slug <slug> [--dry-run] [--expected-max N]",
    );
    process.exit(2);
  }
  return { orgSlug, dryRun, expectedMax };
}

async function listDeletedInWhaapy(): Promise<ContactRow[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("deleted_in_whaapy", true)
    .order("last_whaapy_activity_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ContactRow[];
}

async function main(): Promise<void> {
  const args = parseArgs();
  void getSupabaseAdminClient();

  const org = await getOrganizationBySlug(args.orgSlug);
  if (!org) {
    console.error(`org ${args.orgSlug} no encontrada`);
    process.exit(1);
  }

  console.log(
    `Correctivo de archivado por borrado en Whaapy · "${org.name}" (dry-run=${args.dryRun}).\n`,
  );

  await withTenantContext(
    org.id as UUID,
    async () => {
      const contacts = await listDeletedInWhaapy();
      console.log(`Contactos con deleted_in_whaapy=true: ${contacts.length}\n`);

      if (contacts.length === 0) {
        console.log("Nada que corregir. Salida limpia.");
        return;
      }
      if (contacts.length > args.expectedMax) {
        console.error(
          `ABORTADO: ${contacts.length} candidatos > tope ${args.expectedMax}. ` +
            `Re-correr con --expected-max ${contacts.length} si es esperado.`,
        );
        process.exit(3);
      }

      let totalCancelled = 0;
      let totalTagged = 0;
      let totalPreserved = 0;

      for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i];
        const tag = args.dryRun ? "[dry-run]" : "[live]";
        // deletedAt = su último modificado (ya refleja el borrado) — no
        // adelanta el reloj LWW en contactos ya marcados.
        const result = await archiveContactForWhaapyDeletion({
          contact: c,
          deletedAt: c.last_modified_at,
          source: "corrective_backfill",
          dryRun: args.dryRun,
        });

        totalCancelled += result.cancelledOpportunityIds.length;
        totalPreserved += result.preservedTerminalOpportunityIds.length;
        if (result.shopifyTagged) totalTagged++;

        const shopifyNote = c.shopify_customer_id
          ? result.shopifyTagged
            ? `tag Shopify ✅`
            : `tag Shopify ⏭️ (${result.shopifySkipReason})`
          : "sin Shopify";
        console.log(
          `${tag} ${i + 1}/${contacts.length} ${c.full_name ?? "(sin nombre)"} [${c.id}]\n` +
            `        whaapy_id=${c.whaapy_contact_id ? "presente (badge se apaga por derivación)" : "—"}\n` +
            `        cancelar opps no-terminales: ${result.cancelledOpportunityIds.length} ` +
            `${result.cancelledOpportunityIds.length ? `(${result.cancelledOpportunityIds.join(", ")})` : ""}\n` +
            `        preservar terminales (Ganada/Perdida): ${result.preservedTerminalOpportunityIds.length} ` +
            `${result.preservedTerminalOpportunityIds.length ? `(${result.preservedTerminalOpportunityIds.join(", ")})` : ""}\n` +
            `        ${shopifyNote}`,
        );
      }

      console.log("\n=== Reporte ===");
      console.log(`  contactos procesados:           ${contacts.length}`);
      console.log(`  opps no-terminales ${args.dryRun ? "a cancelar" : "canceladas"}:  ${totalCancelled}`);
      console.log(`  opps terminales preservadas:    ${totalPreserved}`);
      console.log(`  customers Shopify ${args.dryRun ? "a etiquetar" : "etiquetados"}: ${totalTagged}`);
      if (args.dryRun) {
        console.log("\n  (re-correr SIN --dry-run para aplicar)");
      }
    },
    { source: "script" },
  );
}

main().catch((err: Error) => {
  console.error("archive-whaapy-deleted-contacts falló:", err.message);
  process.exit(1);
});
