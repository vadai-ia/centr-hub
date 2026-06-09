/* eslint-disable no-console */
/**
 * Correctivo one-shot — cancela oportunidades de Funnel Venta cuya
 * Draft Order ya NO existe en Shopify (GET → 404). Reusa EXACTAMENTE el
 * mismo mecanismo que el webhook `draft_orders/delete`
 * (`cancelOpportunity` con `source = 'shopify_draft_deleted'`), así que
 * estas cancelaciones quedan indistinguibles de las automáticas en
 * `cancellation_source`. La nota dice "Borrado de Shopify" para que el
 * operador entienda qué pasó y no lo confunda con un bug.
 *
 * Por qué existe (ver ERRORES.md "Cotizaciones fantasma con Draft Order
 * borrado en Shopify"): hay opps en etapa "Cotización" cuyo draft fue
 * borrado en Shopify antes de que el webhook `draft_orders/delete`
 * existiera (o cuyo evento se perdió). Quedan como cotizaciones fantasma
 * que inflan KPIs. Como la plataforma debe reflejar Shopify, se cancelan
 * con metadata (NO borrado físico — R5, cancelado ≠ perdido).
 *
 * Set conocido a corregir (7 referencias confirmadas 404 por el operador):
 *   #D967, #D968, #D969, #D970, #D971, #D981, #D987
 *
 * Garantías:
 *   - SOLO cancela las que Shopify confirma 404. Si el GET devuelve 200
 *     (el draft SÍ existe), NO se toca — se reporta. Si devuelve otro
 *     error (rate limit persistente, red), tampoco se toca.
 *   - Cancelado ≠ perdido (R5): usa `cancelOpportunity`, preserva etapa,
 *     NO inserta en `opportunity_stage_history`, NO contamina win rate.
 *   - Idempotente: `cancelOpportunity` preserva el primer `cancelled_at`;
 *     re-correr reporta `already_cancelled` y no re-marca.
 *   - Match defensivo: filtra `funnel = 'venta'` — la hija de Post-venta
 *     hereda `display_reference` (migración 0021) pero NO
 *     `shopify_draft_order_id`, así que jamás se cancela una hija por
 *     error. La verificación 404 corre contra el `shopify_draft_order_id`
 *     de la opp de Venta, que es el único draft real.
 *   - Audit log `opportunity_cancelled_deleted_draft_corrective` por cada
 *     cancelación efectiva (solo en modo live), con la referencia y el
 *     draft id para trazabilidad.
 *   - Dry-run primero (`--dry-run`): hace los GET a Shopify (read-only)
 *     para reportar cuáles dan 404 / 200 / error, pero NO escribe a BD.
 *
 * Uso:
 *   # Dry-run (no escribe; reporta plan + verificación 404/200):
 *   npm run maintenance:cancel-deleted-draft-opportunities -- --org-slug centr --dry-run
 *
 *   # Corrida en vivo (SOLO tras validar el dry-run con el operador):
 *   npm run maintenance:cancel-deleted-draft-opportunities -- --org-slug centr
 *
 *   # Referencias custom (default = las 7 conocidas) y throttle:
 *   npm run maintenance:cancel-deleted-draft-opportunities -- --org-slug centr --refs "#D967,#D968" --delay-ms 250
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import { ShopifyApiError, shopifyRest } from "@/lib/shopify/admin-client";
import { cancelOpportunity } from "@/lib/db/opportunities";
import { recordAuditEvent } from "@/lib/db/operational";
import type { OpportunityRow, PipelineStageRow, UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

/** Las 7 referencias confirmadas 404 por el operador (prompt del milestone). */
const DEFAULT_REFERENCES = [
  "#D967",
  "#D968",
  "#D969",
  "#D970",
  "#D971",
  "#D981",
  "#D987",
];

interface Args {
  orgSlug: string;
  dryRun: boolean;
  references: string[];
  /** Si true, ignora --refs y barre TODAS las opps activas de Funnel
   *  Venta en la etapa "Cotización", verificando cada draft contra
   *  Shopify y cancelando las 404. Cubre fantasmas más allá de las 7. */
  allCotizacion: boolean;
  /** Tope defensivo: si las opps a cancelar exceden este número, abortar
   *  sin aplicar para que el operador valide. Default = #referencias
   *  (modo refs) o 100 (modo --all-cotizacion). */
  expectedMax: number;
  /** Pausa entre GETs a Shopify (rate limit REST ~2/seg). Default 250ms. */
  delayMs: number;
}

function parseArgs(): Args {
  let orgSlug: string | null = null;
  let dryRun = false;
  let references = DEFAULT_REFERENCES;
  let allCotizacion = false;
  let expectedMax: number | null = null;
  let delayMs = 250;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--all-cotizacion") allCotizacion = true;
    else if (argv[i] === "--refs") {
      const raw = argv[++i] ?? "";
      references = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (argv[i] === "--expected-max") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) expectedMax = n;
    } else if (argv[i] === "--delay-ms") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 0) delayMs = n;
    }
  }
  if (!orgSlug) {
    console.error(
      "Uso: tsx cancel-deleted-draft-opportunities.ts --org-slug <slug> [--dry-run] [--all-cotizacion] [--refs \"#D967,#D968\"] [--expected-max N] [--delay-ms N]",
    );
    process.exit(2);
  }
  if (!allCotizacion && references.length === 0) {
    console.error("--refs no puede quedar vacío");
    process.exit(2);
  }
  return {
    orgSlug,
    dryRun,
    references,
    allCotizacion,
    expectedMax: expectedMax ?? (allCotizacion ? 100 : references.length),
    delayMs,
  };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((res) => setTimeout(res, ms));
}

type Verdict =
  | "confirmed_404" // draft NO existe → cancelar
  | "exists_200" // draft SÍ existe → NO tocar
  | "no_draft_id" // opp sin shopify_draft_order_id → no verificable, NO tocar
  | "shopify_error" // error no-404 al consultar → NO tocar
  | "already_cancelled" // ya cancelada → no-op
  | "ref_not_found"; // ninguna opp de Venta con esa referencia

interface RefResult {
  reference: string;
  opp: OpportunityRow | null;
  stageName: string | null;
  verdict: Verdict;
}

async function resolveStageNames(): Promise<Map<UUID, string>> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("pipeline_stages")
    .select("id, name")
    .eq("organization_id", organizationId);
  if (error) throw error;
  const m = new Map<UUID, string>();
  for (const s of (data ?? []) as Pick<PipelineStageRow, "id" | "name">[]) {
    m.set(s.id, s.name);
  }
  return m;
}

/**
 * Encuentra la opp de Funnel VENTA con `display_reference = ref`. Filtra
 * funnel='venta' a propósito: la hija de Post-venta hereda
 * `display_reference` (0021) pero no es la que tiene el draft real.
 */
async function findVentaOppByReference(
  reference: string,
): Promise<OpportunityRow | null> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("funnel", "venta")
    .eq("display_reference", reference);
  if (error) throw error;
  const rows = (data ?? []) as OpportunityRow[];
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    console.warn(
      `  ! ${reference}: ${rows.length} opps de Venta con esta referencia ` +
        `(se esperaba 1). Se usa la que tiene shopify_draft_order_id; ` +
        `si hay ambigüedad, revisar manualmente.`,
    );
    const withDraft = rows.find((r) => r.shopify_draft_order_id);
    return withDraft ?? rows[0];
  }
  return rows[0];
}

/** Un objetivo a verificar: una opp candidata + la etiqueta para reportarla. */
interface Target {
  reference: string;
  opp: OpportunityRow | null;
}

/**
 * Resuelve la(s) etapa(s) "Cotización" de Funnel Venta por nombre
 * normalizado (igual criterio que el worker de draft orders y la
 * absorción de M7.2: anclar por nombre "Cotización"). Tolera acento y
 * casing. Devuelve los ids encontrados.
 */
async function resolveCotizacionStageIds(): Promise<UUID[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("pipeline_stages")
    .select("id, name")
    .eq("organization_id", organizationId)
    .eq("funnel", "venta");
  if (error) throw error;
  const norm = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .trim()
      .toLowerCase();
  return ((data ?? []) as Pick<PipelineStageRow, "id" | "name">[])
    .filter((s) => norm(s.name).startsWith("cotiz"))
    .map((s) => s.id);
}

/**
 * Modo --all-cotizacion: lista las opps ACTIVAS (cancelled_at IS NULL)
 * de Funnel Venta en la etapa "Cotización". Cada una se verifica luego
 * contra Shopify; solo las 404 se cancelan.
 */
async function gatherCotizacionTargets(): Promise<Target[]> {
  const stageIds = await resolveCotizacionStageIds();
  if (stageIds.length === 0) {
    throw new Error(
      'no se encontró etapa "Cotización" en Funnel Venta — abortando antes de tocar nada',
    );
  }
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("funnel", "venta")
    .is("cancelled_at", null)
    .in("stage_id", stageIds);
  if (error) throw error;
  const rows = (data ?? []) as OpportunityRow[];
  return rows.map((opp) => ({
    reference: opp.display_reference ?? `draft:${opp.shopify_draft_order_id ?? opp.id}`,
    opp,
  }));
}

/** Verifica si el draft existe en Shopify. 404 → no existe. */
async function verifyDraftExists(
  draftOrderId: string,
  ctx: { organizationId: UUID; shopDomain: string },
): Promise<"404" | "200" | "error"> {
  try {
    await shopifyRest<{ draft_order: unknown }>(
      ctx,
      "GET",
      `/draft_orders/${draftOrderId}.json`,
    );
    return "200";
  } catch (err) {
    if (err instanceof ShopifyApiError && err.status === 404) return "404";
    console.error(
      `  ! error al consultar draft_order ${draftOrderId}: ${(err as Error).message}`,
    );
    return "error";
  }
}

async function main() {
  const args = parseArgs();
  void getSupabaseAdminClient();

  const org = await getOrganizationBySlug(args.orgSlug);
  if (!org) {
    console.error(`org ${args.orgSlug} no encontrada`);
    process.exit(1);
  }
  if (!org.shopify_store_domain) {
    console.error(`org ${args.orgSlug} no tiene shopify_store_domain`);
    process.exit(1);
  }
  const ctx = {
    organizationId: org.id as UUID,
    shopDomain: org.shopify_store_domain,
  };

  console.log(
    `Correctivo de cotizaciones con draft borrado en "${org.name}" ` +
      `(dry-run=${args.dryRun}, modo=${args.allCotizacion ? "all-cotizacion" : "refs:" + args.references.length}, delay=${args.delayMs}ms).`,
  );

  await withTenantContext(
    org.id as UUID,
    async () => {
      const stageNames = await resolveStageNames();

      // Construir la lista de objetivos según el modo.
      const targets: Target[] = args.allCotizacion
        ? await gatherCotizacionTargets()
        : await Promise.all(
            args.references.map(async (reference) => ({
              reference,
              opp: await findVentaOppByReference(reference),
            })),
          );

      if (args.allCotizacion) {
        console.log(
          `Opps activas en etapa "Cotización" (Funnel Venta): ${targets.length}`,
        );
        if (targets.length === 0) {
          console.log("Nada que verificar. Salida limpia.");
          return;
        }
      }

      // FASE 1 — verificar existencia de cada draft en Shopify (read-only).
      const results: RefResult[] = [];
      let verified = 0;
      for (const { reference, opp } of targets) {
        if (args.allCotizacion && ++verified % 25 === 0) {
          console.log(`  ...verificadas ${verified}/${targets.length}`);
        }
        if (!opp) {
          results.push({ reference, opp: null, stageName: null, verdict: "ref_not_found" });
          continue;
        }
        const stageName = stageNames.get(opp.stage_id) ?? null;
        if (opp.cancelled_at) {
          results.push({ reference, opp, stageName, verdict: "already_cancelled" });
          continue;
        }
        if (!opp.shopify_draft_order_id) {
          results.push({ reference, opp, stageName, verdict: "no_draft_id" });
          continue;
        }
        const existence = await verifyDraftExists(opp.shopify_draft_order_id, ctx);
        await sleep(args.delayMs);
        results.push({
          reference,
          opp,
          stageName,
          verdict:
            existence === "404"
              ? "confirmed_404"
              : existence === "200"
                ? "exists_200"
                : "shopify_error",
        });
      }

      const toCancel = results.filter((r) => r.verdict === "confirmed_404");

      // Reporte de verificación ANTES de cualquier escritura.
      console.log("\n=== Verificación contra Shopify ===");
      printVerification(results);

      // Tope defensivo.
      if (toCancel.length > args.expectedMax) {
        console.error(
          `\nABORTADO: ${toCancel.length} opps a cancelar excede el tope ` +
            `defensivo ${args.expectedMax}. Re-correr con --expected-max ` +
            `${toCancel.length} si es esperado, o investigar antes.`,
        );
        process.exit(3);
      }

      if (args.dryRun) {
        console.log(
          "\n=== Reporte (dry-run) ===\n" +
            `  se cancelarían (404 confirmado): ${toCancel.length}\n` +
            `  existen en Shopify (NO se tocan): ${results.filter((r) => r.verdict === "exists_200").length}\n` +
            `  ya canceladas (no-op): ${results.filter((r) => r.verdict === "already_cancelled").length}\n` +
            `  sin draft id / referencia no encontrada / error: ${
              results.filter((r) =>
                ["no_draft_id", "ref_not_found", "shopify_error"].includes(r.verdict),
              ).length
            }\n` +
            "  (re-correr SIN --dry-run para aplicar, tras validar el operador)",
        );
        return;
      }

      // FASE 2 — live: cancelar SOLO las confirmadas 404.
      let cancelled = 0;
      let alreadyCancelled = 0;
      for (const r of toCancel) {
        const opp = r.opp!;
        const result = await cancelOpportunity({
          opportunityId: opp.id,
          source: "shopify_draft_deleted",
          note: `Borrado de Shopify — Draft Order ${r.reference} ya no existe en Shopify (404 confirmado). Correctivo administrativo, no es pérdida comercial.`,
        });
        if (result.alreadyCancelled) {
          alreadyCancelled++;
          continue;
        }
        await recordAuditEvent({
          actorUserId: null,
          eventType: "opportunity_cancelled_deleted_draft_corrective",
          entityType: "opportunity",
          entityId: opp.id,
          payload: {
            display_reference: r.reference,
            shopify_draft_order_id: opp.shopify_draft_order_id,
            stage_name: r.stageName,
            cancellation_source: "shopify_draft_deleted",
          },
        });
        cancelled++;
        console.log(
          `[live] cancelada ${r.reference} (opp=${opp.id}, etapa=${r.stageName ?? "?"})`,
        );
      }

      console.log(
        "\n=== Reporte (live) ===\n" +
          `  canceladas:            ${cancelled}\n` +
          `  ya estaban canceladas: ${alreadyCancelled}\n` +
          `  no tocadas (existen / sin draft / no encontradas / error): ${
            results.length - cancelled - alreadyCancelled
          }`,
      );
    },
    { source: "script" },
  );
}

function printVerification(results: RefResult[]): void {
  const labels: Record<Verdict, string> = {
    confirmed_404: "404 → CANCELAR",
    exists_200: "200 existe → NO tocar",
    no_draft_id: "sin draft id → NO tocar",
    shopify_error: "error consulta → NO tocar",
    already_cancelled: "ya cancelada → no-op",
    ref_not_found: "referencia no encontrada en Venta",
  };
  for (const r of results) {
    let oppPart = "(sin opp)";
    if (r.opp) {
      oppPart = `opp=${r.opp.id} draft=${r.opp.shopify_draft_order_id ?? "—"} etapa=${r.stageName ?? "?"}`;
      if (r.verdict === "already_cancelled") {
        oppPart +=
          ` source=${r.opp.cancellation_source ?? "—"}` +
          ` cancelled_at=${r.opp.cancelled_at ?? "—"}` +
          ` note="${r.opp.cancellation_note ?? "—"}"`;
      }
    }
    console.log(`  - ${r.reference}: ${labels[r.verdict]} :: ${oppPart}`);
  }
}

main().catch((err: Error) => {
  console.error("cancel-deleted-draft-opportunities falló:", err.message);
  process.exit(1);
});
