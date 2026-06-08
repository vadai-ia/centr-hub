/* eslint-disable no-console */
/**
 * Correctivo — re-atribuye el asesor de las hijas de Post-venta para que
 * tomen el asesor de su ORDEN cerrada cuando corresponde (fix 0022).
 *
 * Las hijas creadas por el trigger 0020/0021 heredaron el asesor de la
 * F1 madre, que muchas veces está sin asignar (NULL) aunque su orden sí
 * tenga asesor (vía parser de tags). Este script las realinea reusando
 * EXACTAMENTE el mecanismo del sistema: el RPC
 * `reattribute_postventa_child_advisor` (migración 0022), la misma
 * semántica que el trigger arreglado y que el hook de orders/*. NO es
 * SQL crudo suelto.
 *
 * Ver ERRORES.md "Hija de Post-venta hereda el asesor de la F1 (NULL)
 * en vez del de la orden cerrada" para el contexto completo.
 *
 * Garantías (provistas por el RPC):
 *   - Solo cambia el asesor de la hija si la ORDEN tiene asesor y difiere
 *     del actual de la hija. Si la orden no tiene asesor → noop (el
 *     fallback a la F1 ya es correcto).
 *   - Idempotente: si ya está alineado → noop. Re-correr no corrompe.
 *   - NO pisa reasignaciones manuales: si hay audit_log de reasignación
 *     manual de asesor (actor humano) sobre la hija, se salta. Hoy NO
 *     existe feature de reasignación de oportunidad, así que esa guarda
 *     nunca matchea — toda hija con asesor no-NULL lo tiene por herencia
 *     del trigger, no por acción humana.
 *   - Atómico: en modo live, UPDATE + audit en la misma transacción.
 *   - Solo toca el asesor de la HIJA. Nunca la F1 ni el contacto.
 *   - Audit log `postventa_child_advisor_reattributed` por cada hija
 *     efectivamente re-atribuida.
 *
 * Uso:
 *   # Dry-run (no toca BD, solo lista qué hijas reasignaría y de quién a quién):
 *   npm run maintenance:reattribute-postventa-child-advisor -- --org-slug centr --dry-run
 *
 *   # Corrida en vivo (SOLO después de validar el dry-run):
 *   npm run maintenance:reattribute-postventa-child-advisor -- --org-slug centr
 *
 *   # Tope defensivo: si la detección excede este número, abortar.
 *   npm run maintenance:reattribute-postventa-child-advisor -- --org-slug centr --expected-max 50
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import {
  reattributePostventaChildAdvisor,
  type ReattributeChildAdvisorResult,
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
      "Uso: tsx reattribute-postventa-child-advisor.ts --org-slug <slug> [--dry-run] [--expected-max N]",
    );
    process.exit(2);
  }
  return { orgSlug, dryRun, expectedMax };
}

/**
 * Enumera TODAS las hijas de Post-venta de la org (con madre). El RPC
 * decide por hija si hay algo que re-atribuir; aquí solo armamos la
 * lista de candidatos a evaluar.
 */
async function listPostventaChildIds(): Promise<UUID[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("funnel", "post_venta")
    .not("parent_opportunity_id", "is", null);
  if (error) throw error;
  return (data ?? []).map((r) => (r as { id: UUID }).id);
}

/**
 * Mapa membership_id → nombre legible (vendedor) para que el dry-run
 * muestre "de quién a quién" en vez de UUIDs. Best-effort: si no se puede
 * resolver, se cae al UUID.
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

function describeReassignment(
  r: ReattributeChildAdvisorResult,
  names: Map<UUID, string>,
): string {
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
    `Correctivo de asesor de hijas Post-venta (desde la orden) en ` +
      `"${org.name}" (dry-run=${args.dryRun}).`,
  );

  await withTenantContext(
    org.id as UUID,
    async () => {
      const names = await loadAdvisorNameMap();
      const childIds = await listPostventaChildIds();
      console.log(`Hijas Post-venta totales (con madre): ${childIds.length}`);

      // FASE 1 — siempre dry-run sobre cada hija para construir el plan.
      const plan: Array<{ id: UUID; result: ReattributeChildAdvisorResult }> = [];
      for (const id of childIds) {
        const result = await reattributePostventaChildAdvisor(id, true, "corrective");
        if (result.status === "would_fix") plan.push({ id, result });
      }

      console.log(`Hijas que se reasignarían: ${plan.length}`);
      if (plan.length === 0) {
        console.log("Nada que re-atribuir. Salida limpia.");
        return;
      }

      console.log("\nPlan de re-atribución (asesor actual → asesor de la orden):");
      for (const { id, result } of plan) {
        console.log(
          `  - hija=${id} (madre=${result.parentOpportunityId}) :: ` +
            `${describeReassignment(result, names)}`,
        );
      }

      // Tope defensivo — si excede lo esperado, abortar sin aplicar.
      if (plan.length > args.expectedMax) {
        console.error(
          `\nABORTADO: ${plan.length} hijas a reasignar excede el tope ` +
            `defensivo ${args.expectedMax}. Re-correr con ` +
            `--expected-max ${plan.length} si el volumen es esperado, ` +
            `o investigar antes de aplicar.`,
        );
        process.exit(3);
      }

      if (args.dryRun) {
        console.log(
          "\n=== Reporte (dry-run) ===\n" +
            `  hijas que se reasignarían: ${plan.length}\n` +
            "  (re-correr SIN --dry-run para aplicar)",
        );
        return;
      }

      // FASE 2 — live: aplicar a cada hija del plan vía el mismo RPC.
      let fixed = 0;
      let noop = 0;
      let skipped = 0;
      for (let i = 0; i < plan.length; i++) {
        const { id } = plan[i];
        const result = await reattributePostventaChildAdvisor(id, false, "corrective");
        if (result.status === "fixed") {
          fixed++;
          console.log(
            `[live] ${i + 1}/${plan.length} hija=${id} reasignada ` +
              `(${describeReassignment(result, names)})`,
          );
        } else if (result.status === "noop") {
          // Cambió el estado entre la fase de plan y la aplicación
          // (otra corrida concurrente, hook de orders/*, etc.) —
          // idempotente, se reporta.
          noop++;
          console.log(
            `[live] ${i + 1}/${plan.length} hija=${id} noop (${result.reason ?? "sin cambios"})`,
          );
        } else {
          skipped++;
          console.log(
            `[live] ${i + 1}/${plan.length} hija=${id} ${result.status} ` +
              `(${result.reason ?? "sin detalle"})`,
          );
        }
      }

      console.log(
        "\n=== Reporte (live) ===\n" +
          `  hijas reasignadas:        ${fixed}\n` +
          `  hijas sin cambios (noop): ${noop}\n` +
          `  hijas saltadas (skipped): ${skipped}`,
      );
    },
    { source: "script" },
  );
}

main().catch((err: Error) => {
  console.error("reattribute-postventa-child-advisor falló:", err.message);
  process.exit(1);
});
