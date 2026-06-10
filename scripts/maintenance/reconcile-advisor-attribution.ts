/* eslint-disable no-console */
/**
 * Reconciliación de atribución de asesor — corrida MANUAL (la versión
 * automática vive en el cron horario de Inngest
 * `advisor-reattribution-reconcile`).
 *
 * Re-corre los RPC 0022/0023 (mismos que los hooks en vivo) para:
 *   - rellenar el asesor de opps de Venta SIN asesor desde su pedido
 *     enlazado (solo NULL — nunca pisa tag de draft ni manual);
 *   - alinear el asesor de cada hija de Post-venta con el de su orden.
 *
 * Idempotente. NO toca el dashboard (R5/R2): solo escribe asesor de opps.
 *
 * Uso:
 *   npm run maintenance:reconcile-advisor-attribution -- --org-slug centr --dry-run
 *   npm run maintenance:reconcile-advisor-attribution -- --org-slug centr
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import { reconcileAdvisorAttribution } from "@/lib/services/advisor-reconciliation";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function parseArgs() {
  let orgSlug: string | null = null;
  let dryRun = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--dry-run") dryRun = true;
  }
  if (!orgSlug) {
    console.error("Uso: --org-slug <slug> [--dry-run]");
    process.exit(2);
  }
  return { orgSlug, dryRun };
}

async function loadAdvisorNameMap(): Promise<Map<UUID, string>> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("id, profile:user_profiles(full_name)")
    .eq("organization_id", organizationId);
  if (error) throw error;
  const map = new Map<UUID, string>();
  for (const row of (data ?? []) as Array<{
    id: UUID;
    profile: Array<{ full_name: string | null }> | { full_name: string | null } | null;
  }>) {
    const profile = Array.isArray(row.profile) ? row.profile[0] : row.profile;
    if (profile?.full_name) map.set(row.id, profile.full_name);
  }
  return map;
}

function adv(id: UUID | null | undefined, names: Map<UUID, string>): string {
  if (!id) return "(sin asesor)";
  return names.get(id) ?? id;
}

async function main() {
  const { orgSlug, dryRun } = parseArgs();
  void getSupabaseAdminClient();
  const org = await getOrganizationBySlug(orgSlug);
  if (!org) {
    console.error(`org ${orgSlug} no encontrada`);
    process.exit(1);
  }

  console.log(
    `Reconciliación de asesor (Venta + hijas Post-venta) en "${org.name}" (dry-run=${dryRun}).`,
  );

  await withTenantContext(
    org.id as UUID,
    async () => {
      const names = await loadAdvisorNameMap();
      const result = await reconcileAdvisorAttribution({
        dryRun,
        source: dryRun ? "reconcile_manual_dryrun" : "reconcile_manual",
      });

      console.log(`\nCandidatas Venta (sin asesor, con pedido): ${result.ventaCandidates}`);
      console.log(`Hijas Post-venta evaluadas:                 ${result.childCandidates}`);

      console.log(`\nVenta ${dryRun ? "que se rellenarían" : "rellenadas"}: ${result.ventaChanged.length}`);
      for (const v of result.ventaChanged) {
        console.log(
          `  - opp=${v.opportunityId} → ${adv(v.toAdvisorId, names)}` +
            (v.orderShopifyOrderId ? ` [order ${v.orderShopifyOrderId}]` : ""),
        );
      }

      console.log(`\nHijas ${dryRun ? "que se alinearían" : "alineadas"}: ${result.childChanged.length}`);
      for (const c of result.childChanged) {
        console.log(
          `  - hija=${c.childId} :: ${adv(c.fromAdvisorId, names)} → ${adv(c.toAdvisorId, names)}` +
            (c.orderShopifyOrderId ? ` [order ${c.orderShopifyOrderId}]` : ""),
        );
      }

      if (dryRun) {
        console.log("\n(re-correr SIN --dry-run para aplicar)");
      }
    },
    { source: "script" },
  );
}

main().catch((err: Error) => {
  console.error("reconcile-advisor-attribution falló:", err.message);
  process.exit(1);
});
