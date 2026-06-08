/* eslint-disable no-console */
/**
 * Correctivo one-shot — rellena las hijas de Post-venta creadas antes
 * del fix 0021 (datos comerciales en NULL) heredando de su F1 madre:
 * actual_amount, estimated_amount, shopify_order_id, display_reference
 * y line items.
 *
 * Reusa EXACTAMENTE el mecanismo del sistema: el RPC
 * `backfill_f1_to_f2_child` (migración 0021), el mismo conjunto de
 * campos y semántica que el trigger arreglado. NO es SQL crudo suelto —
 * las hijas corregidas quedan idénticas a las que nacerán bien de
 * ahora en adelante.
 *
 * Ver ERRORES.md "Trigger F1→F2 crea la hija de Post-venta sin datos
 * comerciales" para el contexto completo.
 *
 * Garantías (provistas por el RPC):
 *   - Idempotente: scalars se rellenan vía coalesce (solo donde la
 *     hija tiene NULL); line items se copian SOLO si la hija no tiene
 *     ninguno. Correr el script dos veces no duplica ni corrompe.
 *   - Atómico: en modo live, UPDATE + copia de line items + audit
 *     ocurren en la misma transacción del statement.
 *   - shopify_draft_order_id NO se toca (unique constraint + lookup —
 *     ver cabecera de la migración 0021).
 *   - Audit log `trigger_f1_f2_child_backfilled` por cada hija
 *     efectivamente corregida.
 *
 * Uso:
 *   # Dry-run (no toca BD, solo lista cuántas y con qué datos):
 *   npm run maintenance:backfill-postventa-child-data -- --org-slug centr --dry-run
 *
 *   # Corrida en vivo (SOLO después de validar el dry-run):
 *   npm run maintenance:backfill-postventa-child-data -- --org-slug centr
 *
 *   # Tope defensivo: si la detección excede este número, abortar.
 *   npm run maintenance:backfill-postventa-child-data -- --org-slug centr --expected-max 50
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import {
  backfillF1ToF2Child,
  type BackfillF1ToF2ChildResult,
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
      "Uso: tsx backfill-postventa-child-data.ts --org-slug <slug> [--dry-run] [--expected-max N]",
    );
    process.exit(2);
  }
  return { orgSlug, dryRun, expectedMax };
}

/**
 * Enumera TODAS las hijas de Post-venta de la org (con madre). El RPC
 * decide por hija si hay algo que corregir; aquí solo armamos la lista
 * de candidatos a evaluar.
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

function describeChanges(r: BackfillF1ToF2ChildResult): string {
  if (!r.changes) return "";
  const c = r.changes;
  const parts: string[] = [];
  if (c.actual_amount.from !== c.actual_amount.to) {
    parts.push(`actual_amount: ${c.actual_amount.from} → ${c.actual_amount.to}`);
  }
  if (c.estimated_amount.from !== c.estimated_amount.to) {
    parts.push(
      `estimated_amount: ${c.estimated_amount.from} → ${c.estimated_amount.to}`,
    );
  }
  if (c.shopify_order_id.from !== c.shopify_order_id.to) {
    parts.push(
      `shopify_order_id: ${c.shopify_order_id.from} → ${c.shopify_order_id.to}`,
    );
  }
  if (c.display_reference.from !== c.display_reference.to) {
    parts.push(
      `display_reference: ${c.display_reference.from} → ${c.display_reference.to}`,
    );
  }
  if (c.line_items_to_copy > 0) {
    parts.push(`line_items: copiar ${c.line_items_to_copy}`);
  }
  return parts.join(" | ");
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
    `Correctivo de hijas Post-venta sin datos comerciales en "${org.name}" ` +
      `(dry-run=${args.dryRun}).`,
  );

  await withTenantContext(
    org.id as UUID,
    async () => {
      const childIds = await listPostventaChildIds();
      console.log(`Hijas Post-venta totales (con madre): ${childIds.length}`);

      // FASE 1 — siempre dry-run sobre cada hija para construir el plan.
      const plan: Array<{ id: UUID; result: BackfillF1ToF2ChildResult }> = [];
      for (const id of childIds) {
        const result = await backfillF1ToF2Child(id, true);
        if (result.status === "would_fix") plan.push({ id, result });
      }

      console.log(`Hijas que se corregirían: ${plan.length}`);
      if (plan.length === 0) {
        console.log("Nada que corregir. Salida limpia.");
        return;
      }

      console.log("\nPlan de corrección:");
      for (const { id, result } of plan) {
        console.log(
          `  - hija=${id} (madre=${result.parentOpportunityId}) :: ` +
            `${describeChanges(result)}`,
        );
      }

      // Tope defensivo — si excede lo esperado, abortar sin aplicar.
      if (plan.length > args.expectedMax) {
        console.error(
          `\nABORTADO: ${plan.length} hijas a corregir excede el tope ` +
            `defensivo ${args.expectedMax}. Re-correr con ` +
            `--expected-max ${plan.length} si el volumen es esperado, ` +
            `o investigar antes de aplicar.`,
        );
        process.exit(3);
      }

      if (args.dryRun) {
        console.log(
          "\n=== Reporte (dry-run) ===\n" +
            `  hijas que se corregirían: ${plan.length}\n` +
            "  (re-correr SIN --dry-run para aplicar)",
        );
        return;
      }

      // FASE 2 — live: aplicar a cada hija del plan vía el mismo RPC.
      let fixed = 0;
      let noop = 0;
      let lineItemsCopied = 0;
      for (let i = 0; i < plan.length; i++) {
        const { id } = plan[i];
        const result = await backfillF1ToF2Child(id, false);
        if (result.status === "fixed") {
          fixed++;
          lineItemsCopied += result.lineItemsCopied ?? 0;
          console.log(
            `[live] ${i + 1}/${plan.length} hija=${id} corregida ` +
              `(line_items=${result.lineItemsCopied ?? 0})`,
          );
        } else {
          // Cambió el estado entre la fase de plan y la aplicación
          // (otra corrida concurrente, etc.) — idempotente, se reporta.
          noop++;
          console.log(
            `[live] ${i + 1}/${plan.length} hija=${id} ${result.status} ` +
              `(${result.reason ?? "sin cambios"})`,
          );
        }
      }

      console.log(
        "\n=== Reporte (live) ===\n" +
          `  hijas corregidas:        ${fixed}\n` +
          `  hijas sin cambios (noop): ${noop}\n` +
          `  line items copiados:     ${lineItemsCopied}`,
      );
    },
    { source: "script" },
  );
}

main().catch((err: Error) => {
  console.error("backfill-postventa-child-data falló:", err.message);
  process.exit(1);
});
