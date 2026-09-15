/* eslint-disable no-console */
/**
 * Correctivo one-shot — el monto de las oportunidades pasa de TOTAL a SUBTOTAL.
 *
 * Por qué existe (ver ERRORES.md "La venta se mide por subtotal"): el monto de
 * una oportunidad (`opportunities.actual_amount`) se guardaba con el
 * `total_price` de Shopify, que suma el envío. Al vendedor se le mide el
 * `subtotal_price`: productos con descuentos YA restados, sin envío. Los
 * workers nuevos ya escriben el subtotal; este script corrige lo existente.
 *
 * Fuente del monto correcto, por oportunidad:
 *   1. Tiene `shopify_order_id` con pedido local → `orders.subtotal` (sin
 *      llamar a Shopify). Cubre Post-venta, compras online y ventas cerradas.
 *   2. Solo tiene `shopify_draft_order_id` → GET REST del Draft Order +
 *      `mapDraftOrderWebhookToNormalized` (el mismo mapper del worker).
 *      404 = el borrador ya no existe en Shopify: se reporta y NO se toca.
 *
 * NO resta el descuento otra vez: Shopify ya lo descuenta dentro del
 * subtotal (verificado contra pedidos y borradores reales de Centr).
 *
 * Garantías: idempotente (solo escribe si el monto difiere), dry-run por
 * defecto, audit `opportunity_amount_recomputed_to_subtotal` por opp
 * corregida. No toca etapas, fechas, asesores ni pedidos.
 *
 * Uso:
 *   npm run maintenance:recompute-opportunity-amounts-subtotal -- --org-slug centr
 *   npm run maintenance:recompute-opportunity-amounts-subtotal -- --org-slug centr --apply
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getTenantScopedClient } from "@/lib/db/client";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { fetchAllPaged } from "@/lib/db/paginate";
import { updateOpportunity } from "@/lib/db/opportunities";
import { recordAuditEvent } from "@/lib/db/operational";
import { ShopifyApiError, shopifyRest } from "@/lib/shopify/admin-client";
import { mapDraftOrderWebhookToNormalized } from "@/lib/shopify/mappers";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

interface Args {
  orgSlug: string;
  apply: boolean;
  delayMs: number;
}

function parseArgs(): Args {
  let orgSlug: string | null = null;
  let apply = false;
  let delayMs = 250;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--apply") apply = true;
    else if (argv[i] === "--delay-ms") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 0) delayMs = n;
    }
  }
  if (!orgSlug) {
    console.error(
      "Uso: tsx recompute-opportunity-amounts-subtotal.ts --org-slug <slug> [--apply] [--delay-ms N]",
    );
    process.exit(2);
  }
  return { orgSlug, apply, delayMs };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((res) => setTimeout(res, ms));
}

interface OppRow {
  id: UUID;
  funnel: string;
  display_reference: string | null;
  shopify_draft_order_id: string | null;
  shopify_order_id: string | null;
  actual_amount: string | null;
}

interface OrderAmounts {
  subtotal: string;
  total_amount: string;
}

interface Fix {
  opp: OppRow;
  to: string;
  source: "order" | "draft_order";
}

const sameAmount = (a: string | null, b: string) =>
  a !== null && Math.abs(Number(a) - Number(b)) < 0.005;

const money = (v: string | number | null) =>
  v === null ? "null" : Number(v).toLocaleString("es-MX", { maximumFractionDigits: 2 });

async function main() {
  const args = parseArgs();
  const org = await getOrganizationBySlug(args.orgSlug);
  if (!org) {
    console.error(`org ${args.orgSlug} no encontrada`);
    process.exit(1);
  }

  console.log(`Monto de oportunidades → subtotal en "${org.name}" (apply=${args.apply}).`);

  await withTenantContext(
    org.id as UUID,
    async () => {
      const { supabase, organizationId } = getTenantScopedClient();

      const opps = await fetchAllPaged<OppRow>(() =>
        supabase
          .from("opportunities")
          .select("id, funnel, display_reference, shopify_draft_order_id, shopify_order_id, actual_amount")
          .eq("organization_id", organizationId)
          .or("shopify_order_id.not.is.null,shopify_draft_order_id.not.is.null"),
      );
      const orders = await fetchAllPaged<OrderAmounts & { shopify_order_id: string }>(() =>
        supabase
          .from("orders")
          .select("shopify_order_id, subtotal, total_amount")
          .eq("organization_id", organizationId),
      );
      const orderById = new Map(orders.map((o) => [o.shopify_order_id, o] as const));
      console.log(`Oportunidades ligadas a Shopify: ${opps.length} · pedidos locales: ${orders.length}`);

      const fixes: Fix[] = [];
      let aligned = 0;
      const notFound: OppRow[] = [];
      const errored: OppRow[] = [];
      const suspicious: OppRow[] = [];
      let apiCalls = 0;

      for (const opp of opps) {
        const order = opp.shopify_order_id ? orderById.get(opp.shopify_order_id) : undefined;
        if (order) {
          // Subtotal en 0 con total > 0 no es un pedido real sin productos:
          // es una fila sin el dato. No se pisa un monto con un cero dudoso.
          if (Number(order.subtotal) === 0 && Number(order.total_amount) > 0) {
            suspicious.push(opp);
            continue;
          }
          if (sameAmount(opp.actual_amount, order.subtotal)) aligned++;
          else fixes.push({ opp, to: order.subtotal, source: "order" });
          continue;
        }
        if (!opp.shopify_draft_order_id) continue; // pedido aún no importado
        try {
          apiCalls++;
          const res = await shopifyRest<{ draft_order: unknown }>(
            { organizationId: org.id as UUID, shopDomain: org.shopify_store_domain ?? "" },
            "GET",
            `/draft_orders/${opp.shopify_draft_order_id}.json`,
          );
          const subtotal = mapDraftOrderWebhookToNormalized(res.draft_order).subtotalAmount;
          if (sameAmount(opp.actual_amount, subtotal)) aligned++;
          else fixes.push({ opp, to: subtotal, source: "draft_order" });
        } catch (err) {
          if (err instanceof ShopifyApiError && err.status === 404) notFound.push(opp);
          else {
            console.error(`  ! draft ${opp.shopify_draft_order_id}: ${(err as Error).message}`);
            errored.push(opp);
          }
        }
        if (apiCalls % 25 === 0) console.log(`  ...borradores consultados: ${apiCalls}`);
        await sleep(args.delayMs);
      }

      const before = fixes.reduce((s, f) => s + Number(f.opp.actual_amount ?? 0), 0);
      const after = fixes.reduce((s, f) => s + Number(f.to), 0);
      console.log(
        `\nA corregir: ${fixes.length} (desde pedido ${fixes.filter((f) => f.source === "order").length}, ` +
          `desde borrador ${fixes.filter((f) => f.source === "draft_order").length})` +
          `\nYa en subtotal: ${aligned}` +
          `\nBorrador inexistente en Shopify (no se tocan): ${notFound.length}` +
          `\nError al consultar (no se tocan): ${errored.length}` +
          `\nPedido con subtotal 0 y total > 0 (no se tocan): ${suspicious.length}` +
          `\nSuma de montos corregidos: ${money(before)} → ${money(after)}`,
      );
      console.log("Muestra (primeras 20):");
      for (const f of fixes.slice(0, 20)) {
        console.log(
          `  - ${f.opp.funnel.padEnd(10)} ${String(f.opp.display_reference ?? f.opp.shopify_order_id ?? "").padEnd(10)} ` +
            `${money(f.opp.actual_amount)} → ${money(f.to)} (${f.source})`,
        );
      }

      if (!args.apply) {
        console.log("\n(dry-run) Re-correr con --apply para escribir.");
        return;
      }

      let written = 0;
      for (const f of fixes) {
        await updateOpportunity(f.opp.id, { actual_amount: f.to });
        await recordAuditEvent({
          actorUserId: null,
          eventType: "opportunity_amount_recomputed_to_subtotal",
          entityType: "opportunity",
          entityId: f.opp.id,
          payload: { from: f.opp.actual_amount, to: f.to, source: f.source },
        });
        written++;
      }
      console.log(`\nEscritas: ${written}`);
    },
    { source: "script" },
  );
}

main().catch((err: Error) => {
  console.error("recompute-opportunity-amounts-subtotal falló:", err.message);
  process.exit(1);
});
