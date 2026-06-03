/* eslint-disable no-console */
/**
 * Corrección one-shot — cancela los "Lead nuevo" históricos que
 * coexisten con otra oportunidad activa del mismo contacto en Funnel
 * Venta. Reusa EXACTAMENTE el mismo mecanismo de absorción que la
 * lógica preventiva (`absorbInitialStageOpportunities`) — el
 * `cancellation_source` queda en `absorbed_by_advanced_opportunity`,
 * idéntico al de las absorciones automáticas futuras.
 *
 * Ver entrada en ERRORES.md "Lead nuevo duplicado con Cotización
 * activa por race de webhooks (R12 eco de Shopify→Whaapy)" para
 * el contexto completo del bug.
 *
 * Garantías:
 *   - Idempotente: una vez cancelado, el contacto deja de aparecer
 *     en la detección (la query filtra `cancelled_at IS NULL`). Correr
 *     el script dos veces seguidas no toca nada en la segunda corrida.
 *   - No toca la Cotización (ni cualquier otra opp activa no-inicial):
 *     `absorbInitialStageOpportunities` excluye explícitamente la opp
 *     absorbente del set candidato + solo afecta etapas con
 *     `is_initial = true`.
 *   - Cancelado ≠ perdido (R5): usa `cancelOpportunity`, preserva
 *     etapa, NO inserta en `opportunity_stage_history`, NO contamina
 *     win rate.
 *   - Audit log `lead_nuevo_absorbed_by_advanced_opportunity` con
 *     `trigger: "corrective_backfill"` por cada cancelación — los
 *     históricos siguen siendo distinguibles en auditoría aunque
 *     queden idénticos a los automáticos en `cancellation_source`.
 *
 * Uso:
 *   # Dry-run sobre TODOS los candidatos (no toca BD, solo lista):
 *   npm run maintenance:cancel-orphaned-lead-nuevo -- --org-slug centr --dry-run
 *
 *   # Corrida en vivo:
 *   npm run maintenance:cancel-orphaned-lead-nuevo -- --org-slug centr
 *
 *   # Tope de seguridad ante hallazgos inesperados (la regla operativa
 *   # dice "esperar ~8"; si la query encuentra muchos más, el script
 *   # corta y pide confirmación con --expected-max).
 *   npm run maintenance:cancel-orphaned-lead-nuevo -- --org-slug centr --expected-max 12
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import { listOpportunities } from "@/lib/db/opportunities";
import { absorbInitialStageOpportunities } from "@/lib/services/opportunity-absorption";
import type { OpportunityRow, PipelineStageRow, UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

interface Args {
  orgSlug: string;
  dryRun: boolean;
  /** Tope defensivo: si la detección excede este número, abortar sin
   *  aplicar (la regla operativa documentada es ~8). Default 25. */
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
      "Uso: tsx cancel-orphaned-lead-nuevo.ts --org-slug <slug> [--dry-run] [--expected-max N]",
    );
    process.exit(2);
  }
  return { orgSlug, dryRun, expectedMax };
}

interface Candidate {
  contactId: UUID;
  initialOpps: OpportunityRow[];
  advancedOpps: OpportunityRow[];
  /** Opp avanzada elegida como `absorbingOpportunityId` (la más reciente). */
  pickedAbsorbing: OpportunityRow;
}

/**
 * Detección dinámica: encuentra contactos con AL MENOS una opp activa
 * en etapa inicial (`is_initial = true`) Y al menos una opp activa en
 * etapa NO inicial, en Funnel Venta. La elección de la "absorbente"
 * para el audit es la opp avanzada más recientemente modificada — la
 * que mejor refleja la opp "real" del contacto.
 */
async function detectCandidates(): Promise<Candidate[]> {
  const { supabase, organizationId } = getTenantScopedClient();

  // 1. Resolver etapas iniciales (puede haber >1 en teoría — el set se
  //    usa solo para clasificar).
  const { data: stagesData, error: stagesErr } = await supabase
    .from("pipeline_stages")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("funnel", "venta");
  if (stagesErr) throw stagesErr;
  const stages = (stagesData ?? []) as PipelineStageRow[];
  const initialStageIds = new Set(
    stages.filter((s) => s.is_initial).map((s) => s.id),
  );
  if (initialStageIds.size === 0) {
    throw new Error(
      "no se encontró etapa is_initial en Funnel Venta — abortando antes de tocar nada",
    );
  }

  // 2. Trae TODAS las opps activas (cancelled_at IS NULL) en Funnel
  //    Venta — default de `listOpportunities`. Las agrupamos por contact.
  const active = await listOpportunities({ funnel: "venta" });
  const byContact = new Map<UUID, OpportunityRow[]>();
  for (const opp of active) {
    const arr = byContact.get(opp.contact_id) ?? [];
    arr.push(opp);
    byContact.set(opp.contact_id, arr);
  }

  // 3. Para cada contact con >= 2 active opps, clasificar y filtrar
  //    los que coexisten Lead nuevo + otra opp no-inicial.
  const candidates: Candidate[] = [];
  const entries = Array.from(byContact.entries());
  for (const [contactId, opps] of entries) {
    if (opps.length < 2) continue;
    const initial = opps.filter((o: OpportunityRow) =>
      initialStageIds.has(o.stage_id),
    );
    const advanced = opps.filter(
      (o: OpportunityRow) => !initialStageIds.has(o.stage_id),
    );
    if (initial.length === 0 || advanced.length === 0) continue;
    // Pick the most recently modified advanced opp as the "absorbing"
    // reference for audit (typically the Cotización from Shopify).
    const pickedAbsorbing = [...advanced].sort(
      (a: OpportunityRow, b: OpportunityRow) =>
        (b.last_modified_at ?? "").localeCompare(a.last_modified_at ?? ""),
    )[0];
    candidates.push({
      contactId,
      initialOpps: initial,
      advancedOpps: advanced,
      pickedAbsorbing,
    });
  }
  return candidates;
}

async function getContactNames(
  contactIds: UUID[],
): Promise<Map<UUID, string | null>> {
  if (contactIds.length === 0) return new Map();
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("id, full_name")
    .eq("organization_id", organizationId)
    .in("id", contactIds);
  if (error) throw error;
  const m = new Map<UUID, string | null>();
  for (const row of (data ?? []) as Array<{ id: UUID; full_name: string | null }>) {
    m.set(row.id, row.full_name);
  }
  return m;
}

interface Outcome {
  contactId: UUID;
  contactName: string | null;
  absorbedOppIds: UUID[];
  initialOppIds: UUID[];
  absorbingOppId: UUID;
  status: "absorbed" | "dry_run_would_absorb" | "no_op_already_clean";
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
    `Corrección de "Lead nuevo" huérfanos en "${org.name}" (dry-run=${args.dryRun}).`,
  );

  const outcomes: Outcome[] = [];

  await withTenantContext(
    org.id as UUID,
    async () => {
      const candidates = await detectCandidates();
      const names = await getContactNames(candidates.map((c) => c.contactId));

      console.log(
        `Detección dinámica: ${candidates.length} contactos con ` +
          `"Lead nuevo" activo + otra opp activa no-terminal en Funnel Venta.`,
      );

      if (candidates.length === 0) {
        console.log("Nada que corregir. Salida limpia.");
        return;
      }

      // Tope defensivo — la regla operativa documentada espera ~8.
      // Si excede `expected-max`, el script reporta y aborta sin
      // tocar nada para que el operador valide qué cambió.
      if (candidates.length > args.expectedMax) {
        console.error(
          `\nABORTADO: encontré ${candidates.length} candidatos, ` +
            `pero el tope defensivo era ${args.expectedMax}. ` +
            `Re-correr con --expected-max ${candidates.length} si el ` +
            `crecimiento es esperado, o investigar antes de aplicar.`,
        );
        printCandidatesPreview(candidates, names);
        process.exit(3);
      }

      // Listar antes de tocar — el operador ve el plan completo.
      console.log("\nPlan de absorción:");
      printCandidatesPreview(candidates, names);

      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const tag = args.dryRun ? "[dry-run]" : "[live]";
        const name = names.get(c.contactId) ?? "(sin nombre)";
        console.log(
          `${tag} ${i + 1}/${candidates.length} contact=${c.contactId} ` +
            `(${name}) initial_opps=${c.initialOpps.length} ` +
            `absorbing=${c.pickedAbsorbing.id}`,
        );

        if (args.dryRun) {
          outcomes.push({
            contactId: c.contactId,
            contactName: name,
            initialOppIds: c.initialOpps.map((o) => o.id),
            absorbedOppIds: c.initialOpps.map((o) => o.id),
            absorbingOppId: c.pickedAbsorbing.id,
            status: "dry_run_would_absorb",
          });
          continue;
        }

        const result = await absorbInitialStageOpportunities({
          contactId: c.contactId,
          absorbingOpportunityId: c.pickedAbsorbing.id,
          trigger: "corrective_backfill",
        });
        outcomes.push({
          contactId: c.contactId,
          contactName: name,
          initialOppIds: c.initialOpps.map((o) => o.id),
          absorbedOppIds: result.absorbedOpportunityIds,
          absorbingOppId: c.pickedAbsorbing.id,
          status:
            result.absorbedOpportunityIds.length > 0
              ? "absorbed"
              : "no_op_already_clean",
        });
      }
    },
    { source: "script" },
  );

  printReport(outcomes, args.dryRun);
}

function printCandidatesPreview(
  candidates: Candidate[],
  names: Map<UUID, string | null>,
): void {
  for (const c of candidates) {
    const name = names.get(c.contactId) ?? "(sin nombre)";
    console.log(
      `  - ${name} [${c.contactId}]: ${c.initialOpps.length} Lead nuevo → ` +
        `cancelar; deja ${c.advancedOpps.length} avanzada(s) intacta(s) ` +
        `(absorbente=${c.pickedAbsorbing.id})`,
    );
  }
}

function printReport(outcomes: Outcome[], dryRun: boolean): void {
  console.log("\n=== Reporte ===");
  console.log(`  total contactos procesados: ${outcomes.length}`);
  if (dryRun) {
    const would = outcomes.reduce(
      (acc, o) => acc + o.absorbedOppIds.length,
      0,
    );
    console.log(`  Lead nuevo que se cancelarían: ${would}`);
    console.log(
      "  (re-correr SIN --dry-run para aplicar las cancelaciones)",
    );
    return;
  }
  const absorbed = outcomes
    .filter((o) => o.status === "absorbed")
    .reduce((acc, o) => acc + o.absorbedOppIds.length, 0);
  const noOp = outcomes.filter((o) => o.status === "no_op_already_clean").length;
  console.log(`  Lead nuevo cancelados:        ${absorbed}`);
  console.log(`  contactos ya limpios (no-op): ${noOp}`);
  if (absorbed > 0) {
    console.log("\n  Detalle por contacto:");
    for (const o of outcomes) {
      if (o.status !== "absorbed") continue;
      const name = o.contactName ?? "(sin nombre)";
      console.log(
        `    - ${name} [${o.contactId}]: cancel(${o.absorbedOppIds.join(", ")}) ` +
          `absorbed_by ${o.absorbingOppId}`,
      );
    }
  }
}

main().catch((err: Error) => {
  console.error("cancel-orphaned-lead-nuevo falló:", err.message);
  process.exit(1);
});
