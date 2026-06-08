/* eslint-disable no-console */
/**
 * Correctivo — rellena el asesor de las opps de Venta que están SIN
 * asesor para que tomen el asesor de su PEDIDO cuando corresponde
 * (fix 0023).
 *
 * Una opp de Venta puede quedar con `assigned_advisor_id` NULL aunque su
 * pedido sí tenga asesor (vía parser de tags), por la ventana de carrera
 * entre la tag del Draft Order y la tag del pedido. Este script las
 * rellena reusando EXACTAMENTE el mecanismo del sistema: el RPC
 * `reattribute_venta_opportunity_advisor` (migración 0023), la misma
 * semántica que el hook de orders/*. NO es SQL crudo suelto.
 *
 * Ver ERRORES.md "Opp de Venta sin asesor pese a que su pedido tiene
 * asesor (tag de vendedor tardía)" para el contexto completo.
 *
 * Garantías (provistas por el RPC):
 *   - GUARDRAIL CENTRAL: SOLO rellena NULL. Si la opp ya tiene asesor
 *     (tag de draft, herencia o manual), no se toca — NUNCA se pisa.
 *   - Solo rellena si el PEDIDO tiene asesor. Si no, noop (la opp sigue
 *     sin asesor, estado correcto hasta que el pedido aterrice).
 *   - Aplica en cualquier etapa del Funnel Venta.
 *   - Idempotente: tras rellenar, el segundo run salta (ya tiene asesor).
 *   - Atómico: en modo live, UPDATE + audit en la misma transacción.
 *   - Solo toca el asesor de la OPP de Venta. Nunca la orden ni el contacto.
 *   - Audit log `venta_opportunity_advisor_reattributed` por cada opp
 *     efectivamente rellenada.
 *
 * Uso:
 *   # Dry-run (no toca BD, solo lista qué opps rellenaría y a quién):
 *   npm run maintenance:reattribute-venta-opportunity-advisor -- --org-slug centr --dry-run
 *
 *   # Corrida en vivo (SOLO después de validar el dry-run):
 *   npm run maintenance:reattribute-venta-opportunity-advisor -- --org-slug centr
 *
 *   # Tope defensivo: si la detección excede este número, abortar.
 *   npm run maintenance:reattribute-venta-opportunity-advisor -- --org-slug centr --expected-max 50
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import {
  reattributeVentaOpportunityAdvisor,
  type ReattributeVentaOpportunityResult,
} from "@/lib/services/f1-to-f2-trigger";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

interface Args {
  orgSlug: string;
  dryRun: boolean;
  /** Tope defensivo: si la detección excede este número, abortar sin
   *  aplicar para que el operador valide qué cambió. Default 200. */
  expectedMax: number;
}

function parseArgs(): Args {
  let orgSlug: string | null = null;
  let dryRun = false;
  let expectedMax = 200;
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
      "Uso: tsx reattribute-venta-opportunity-advisor.ts --org-slug <slug> [--dry-run] [--expected-max N]",
    );
    process.exit(2);
  }
  return { orgSlug, dryRun, expectedMax };
}

/**
 * Enumera las opps de Venta SIN asesor de la org — el único conjunto de
 * candidatos (la regla solo rellena NULL). El RPC decide por opp si hay
 * un pedido con asesor del que heredar.
 */
async function listUnassignedVentaOpportunityIds(): Promise<UUID[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("funnel", "venta")
    .is("assigned_advisor_id", null);
  if (error) throw error;
  return (data ?? []).map((r) => (r as { id: UUID }).id);
}

/**
 * Mapa membership_id → nombre legible (vendedor) para que el dry-run
 * muestre a quién se asignaría en vez de UUIDs. Best-effort: si no se
 * puede resolver, se cae al UUID.
 */
async function loadAdvisorNameMap(): Promise<Map<UUID, string>> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("id, profile:user_profiles(full_name)")
    .eq("organization_id", organizationId);
  if (error) throw error;
  const map = new Map<UUID, string>();
  // El embedded resource de PostgREST se infiere como array.
  for (const row of (data ?? []) as Array<{
    id: UUID;
    profile: Array<{ full_name: string | null }> | { full_name: string | null } | null;
  }>) {
    const profile = Array.isArray(row.profile) ? row.profile[0] : row.profile;
    if (profile?.full_name) map.set(row.id, profile.full_name);
  }
  return map;
}

function labelAdvisor(
  id: UUID | null | undefined,
  names: Map<UUID, string>,
): string {
  if (!id) return "(sin asesor)";
  return names.get(id) ?? id;
}

function describeAssignment(
  r: ReattributeVentaOpportunityResult,
  names: Map<UUID, string>,
): string {
  // from siempre es "(sin asesor)" — solo rellenamos NULL.
  const from = labelAdvisor(r.fromAdvisorId, names);
  const to = labelAdvisor(r.toAdvisorId, names);
  const order = r.orderShopifyOrderId ? ` [order ${r.orderShopifyOrderId}]` : "";
  return `${from} → ${to}${order}`;
}

async function main() {
  const args = parseArgs();
  void getSupabaseAdminClient();

  const org = await getOrganizationBySlug(args.orgSlug);
  if (!org) {
    console.error(`org ${args.orgSlug} no encontrada`);
    process.exit(1);
  }

  console.log(
    `Correctivo de asesor de opps de Venta (rellena NULL desde el pedido) en ` +
      `"${org.name}" (dry-run=${args.dryRun}).`,
  );

  await withTenantContext(
    org.id as UUID,
    async () => {
      const names = await loadAdvisorNameMap();
      const oppIds = await listUnassignedVentaOpportunityIds();
      console.log(`Opps de Venta sin asesor: ${oppIds.length}`);

      // FASE 1 — siempre dry-run sobre cada opp para construir el plan.
      const plan: Array<{ id: UUID; result: ReattributeVentaOpportunityResult }> = [];
      for (const id of oppIds) {
        const result = await reattributeVentaOpportunityAdvisor(id, true, "corrective");
        if (result.status === "would_fix") plan.push({ id, result });
      }

      console.log(`Opps que se rellenarían: ${plan.length}`);
      if (plan.length === 0) {
        console.log("Nada que rellenar. Salida limpia.");
        return;
      }

      console.log("\nPlan de relleno (sin asesor → asesor del pedido):");
      for (const { id, result } of plan) {
        console.log(`  - opp=${id} :: ${describeAssignment(result, names)}`);
      }

      // Tope defensivo — si excede lo esperado, abortar sin aplicar.
      if (plan.length > args.expectedMax) {
        console.error(
          `\nABORTADO: ${plan.length} opps a rellenar excede el tope ` +
            `defensivo ${args.expectedMax}. Re-correr con ` +
            `--expected-max ${plan.length} si el volumen es esperado, ` +
            `o investigar antes de aplicar.`,
        );
        process.exit(3);
      }

      if (args.dryRun) {
        console.log(
          "\n=== Reporte (dry-run) ===\n" +
            `  opps que se rellenarían: ${plan.length}\n` +
            "  (re-correr SIN --dry-run para aplicar)",
        );
        return;
      }

      // FASE 2 — live: aplicar a cada opp del plan vía el mismo RPC.
      let fixed = 0;
      let noop = 0;
      let skipped = 0;
      for (let i = 0; i < plan.length; i++) {
        const { id } = plan[i];
        const result = await reattributeVentaOpportunityAdvisor(id, false, "corrective");
        if (result.status === "fixed") {
          fixed++;
          console.log(
            `[live] ${i + 1}/${plan.length} opp=${id} rellenada ` +
              `(${describeAssignment(result, names)})`,
          );
        } else if (result.status === "noop") {
          // Cambió el estado entre la fase de plan y la aplicación
          // (hook de orders/*, otra corrida) — idempotente, se reporta.
          noop++;
          console.log(
            `[live] ${i + 1}/${plan.length} opp=${id} noop (${result.reason ?? "sin cambios"})`,
          );
        } else {
          skipped++;
          console.log(
            `[live] ${i + 1}/${plan.length} opp=${id} ${result.status} ` +
              `(${result.reason ?? "sin detalle"})`,
          );
        }
      }

      console.log(
        "\n=== Reporte (live) ===\n" +
          `  opps rellenadas:          ${fixed}\n` +
          `  opps sin cambios (noop):  ${noop}\n` +
          `  opps saltadas (skipped):  ${skipped}`,
      );
    },
    { source: "script" },
  );
}

main().catch((err: Error) => {
  console.error("reattribute-venta-opportunity-advisor falló:", err.message);
  process.exit(1);
});
