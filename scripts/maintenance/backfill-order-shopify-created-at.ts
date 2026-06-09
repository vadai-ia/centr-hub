/* eslint-disable no-console */
/**
 * Correctivo one-shot — rellena `orders.shopify_created_at` (migración
 * 0024) en las órdenes existentes que entraron a la BD ANTES del fix,
 * trayendo la fecha real de creación del pedido desde Shopify.
 *
 * Por qué existe (ver ERRORES.md "Orders fechadas por created_at de BD
 * en vez de la fecha real de Shopify"): el dashboard contaba "Pedidos
 * en el periodo" y "Pedidos por mes" por `created_at` de BD. Una
 * carga/sync masivo metió 69 órdenes el 4-jun cuyo pedido real en
 * Shopify va de nov-2025 a abr-2026 — contadas todas como junio. Con
 * filtro 1-9 junio el dashboard mostró 102 pedidos; el real es ~22.
 *
 * Reusa EXACTAMENTE el mecanismo del sync: GET REST del pedido +
 * `mapOrderWebhookToNormalized` (el mismo mapper de los workers de
 * webhooks y del backfill incremental). NO inventa lógica de parseo de
 * fecha aparte — toma `normalized.createdAt` (= `created_at` del objeto
 * Order de Shopify) y escribe SOLO esa columna. No toca montos, tags,
 * asesor, paid_at ni dispara hooks de re-atribución.
 *
 * Garantías:
 *   - Idempotente: solo procesa filas con `shopify_created_at IS NULL`;
 *     una vez poblada, deja de aparecer en el set. Re-correr no
 *     reprocesa ni corrompe.
 *   - Dry-run primero (`--dry-run`): hace los GET a Shopify (read-only)
 *     para reportar a qué fecha refecharía cada orden y verificar
 *     existencia, pero NO escribe a la BD.
 *   - Verificación de existencia: un GET que devuelve 404 significa que
 *     el pedido NO existe en Shopify. El correctivo lo REPORTA y NO lo
 *     toca (no borra nada — decisión del operador, ver prompt).
 *   - Audit log `order_shopify_created_at_backfilled` por cada orden
 *     efectivamente refechada (solo en modo live).
 *
 * Uso:
 *   # Dry-run (no escribe; reporta plan + verificación de las huérfanas):
 *   npm run maintenance:backfill-order-shopify-created-at -- --org-slug centr --dry-run
 *
 *   # Corrida en vivo (SOLO después de validar el dry-run con el operador):
 *   npm run maintenance:backfill-order-shopify-created-at -- --org-slug centr
 *
 *   # Tope defensivo y throttle de Shopify (req/seg):
 *   npm run maintenance:backfill-order-shopify-created-at -- --org-slug centr --expected-max 500 --delay-ms 250
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { ShopifyApiError, shopifyRest } from "@/lib/shopify/admin-client";
import { mapOrderWebhookToNormalized } from "@/lib/shopify/mappers";
import {
  listOrdersMissingShopifyCreatedAt,
  updateOrder,
  type OrderMissingShopifyCreatedAt,
} from "@/lib/db/orders";
import { recordAuditEvent } from "@/lib/db/operational";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

interface Args {
  orgSlug: string;
  dryRun: boolean;
  /** Tope defensivo: si las órdenes a refechar exceden este número,
   *  abortar sin aplicar para que el operador valide. Default 2000. */
  expectedMax: number;
  /** Pausa entre GETs a Shopify (rate limit REST ~2/seg). Default 250ms. */
  delayMs: number;
}

function parseArgs(): Args {
  let orgSlug: string | null = null;
  let dryRun = false;
  let expectedMax = 2000;
  let delayMs = 250;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--expected-max") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) expectedMax = n;
    } else if (argv[i] === "--delay-ms") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 0) delayMs = n;
    }
  }
  if (!orgSlug) {
    console.error(
      "Uso: tsx backfill-order-shopify-created-at.ts --org-slug <slug> [--dry-run] [--expected-max N] [--delay-ms N]",
    );
    process.exit(2);
  }
  return { orgSlug, dryRun, expectedMax, delayMs };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((res) => setTimeout(res, ms));
}

interface ResolvedRow {
  order: OrderMissingShopifyCreatedAt;
  /** Fecha real de Shopify a escribir, o null si no se pudo resolver. */
  shopifyCreatedAt: string | null;
  /** true si Shopify devolvió 404 (el pedido no existe allá). */
  notFoundInShopify: boolean;
  /** Otro error no-404 (rate limit persistente, etc.). */
  errored: boolean;
}

/**
 * Resuelve la fecha real de Shopify de UNA orden vía el mismo path que
 * el sync: GET REST + mapper. 404 → no existe (se reporta, no se toca).
 */
async function resolveShopifyCreatedAt(
  order: OrderMissingShopifyCreatedAt,
  ctx: { organizationId: UUID; shopDomain: string },
): Promise<ResolvedRow> {
  try {
    const res = await shopifyRest<{ order: unknown }>(
      ctx,
      "GET",
      `/orders/${order.shopify_order_id}.json`,
    );
    const normalized = mapOrderWebhookToNormalized(res.order);
    return {
      order,
      shopifyCreatedAt: normalized.createdAt,
      notFoundInShopify: false,
      errored: false,
    };
  } catch (err) {
    if (err instanceof ShopifyApiError && err.status === 404) {
      return { order, shopifyCreatedAt: null, notFoundInShopify: true, errored: false };
    }
    console.error(
      `  ! error al consultar order ${order.shopify_order_id}: ${(err as Error).message}`,
    );
    return { order, shopifyCreatedAt: null, notFoundInShopify: false, errored: true };
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
    `Correctivo shopify_created_at en "${org.name}" (dry-run=${args.dryRun}, delay=${args.delayMs}ms).`,
  );

  await withTenantContext(
    org.id as UUID,
    async () => {
      const missing = await listOrdersMissingShopifyCreatedAt();
      console.log(`Órdenes sin shopify_created_at: ${missing.length}`);
      if (missing.length === 0) {
        console.log("Nada que corregir. Salida limpia.");
        return;
      }

      // FASE 1 — resolver contra Shopify (read-only). Construye el plan
      // y la verificación de existencia ANTES de cualquier escritura.
      const resolved: ResolvedRow[] = [];
      for (let i = 0; i < missing.length; i++) {
        const r = await resolveShopifyCreatedAt(missing[i], ctx);
        resolved.push(r);
        if ((i + 1) % 25 === 0) {
          console.log(`  ...verificadas ${i + 1}/${missing.length}`);
        }
        await sleep(args.delayMs);
      }

      const toRefecha = resolved.filter((r) => r.shopifyCreatedAt !== null);
      const notFound = resolved.filter((r) => r.notFoundInShopify);
      const errored = resolved.filter((r) => r.errored);

      // Subconjunto huérfanas (sin opportunity_id, O6) — las 69 del 4-jun.
      const orphans = resolved.filter((r) => r.order.opportunity_id === null);
      const orphansFound = orphans.filter((r) => r.shopifyCreatedAt !== null);
      const orphansNotFound = orphans.filter((r) => r.notFoundInShopify);

      console.log("\n=== Verificación de existencia en Shopify ===");
      console.log(`  total sin fecha:        ${missing.length}`);
      console.log(`  existen en Shopify:     ${toRefecha.length}`);
      console.log(`  NO existen (404):       ${notFound.length}`);
      console.log(`  error al consultar:     ${errored.length}`);
      console.log(`  -- huérfanas (sin opportunity_id, O6): ${orphans.length}`);
      console.log(`       de ellas existen:  ${orphansFound.length}`);
      console.log(`       de ellas NO existen (404): ${orphansNotFound.length}`);

      if (notFound.length > 0) {
        console.log(
          "\n  Órdenes que NO existen en Shopify (NO se tocan — decisión del operador):",
        );
        for (const r of notFound) {
          console.log(
            `    - order=${r.order.id} shopify_order_id=${r.order.shopify_order_id} ` +
              `huérfana=${r.order.opportunity_id === null} (entró a BD ${r.order.created_at})`,
          );
        }
      }

      console.log("\n=== Plan de refecha (primeras 30) ===");
      for (const r of toRefecha.slice(0, 30)) {
        console.log(
          `  - order=${r.order.id} shopify_order_id=${r.order.shopify_order_id} :: ` +
            `shopify_created_at: NULL → ${r.shopifyCreatedAt} (BD created_at=${r.order.created_at})`,
        );
      }
      if (toRefecha.length > 30) {
        console.log(`  ... y ${toRefecha.length - 30} más.`);
      }

      // Tope defensivo.
      if (toRefecha.length > args.expectedMax) {
        console.error(
          `\nABORTADO: ${toRefecha.length} órdenes a refechar excede el tope ` +
            `defensivo ${args.expectedMax}. Re-correr con --expected-max ` +
            `${toRefecha.length} si el volumen es esperado, o investigar antes.`,
        );
        process.exit(3);
      }

      if (args.dryRun) {
        console.log(
          "\n=== Reporte (dry-run) ===\n" +
            `  órdenes que se refecharían: ${toRefecha.length}\n` +
            `  no existen en Shopify (se reportan, NO se tocan): ${notFound.length}\n` +
            "  (re-correr SIN --dry-run para aplicar, tras validar el operador)",
        );
        return;
      }

      // FASE 2 — live: escribir SOLO shopify_created_at + audit por orden.
      let fixed = 0;
      for (let i = 0; i < toRefecha.length; i++) {
        const r = toRefecha[i];
        await updateOrder(r.order.id, {
          shopify_created_at: r.shopifyCreatedAt,
        });
        await recordAuditEvent({
          actorUserId: null,
          eventType: "order_shopify_created_at_backfilled",
          entityType: "order",
          entityId: r.order.id,
          payload: {
            shopify_order_id: r.order.shopify_order_id,
            shopify_created_at: r.shopifyCreatedAt,
            db_created_at: r.order.created_at,
            was_orphan: r.order.opportunity_id === null,
          },
        });
        fixed++;
        if ((i + 1) % 25 === 0) {
          console.log(`[live] refechadas ${i + 1}/${toRefecha.length}`);
        }
      }

      console.log(
        "\n=== Reporte (live) ===\n" +
          `  órdenes refechadas:     ${fixed}\n` +
          `  no existen en Shopify (no tocadas): ${notFound.length}\n` +
          `  errores al consultar:   ${errored.length}`,
      );
    },
    { source: "script" },
  );
}

main().catch((err: Error) => {
  console.error("backfill-order-shopify-created-at falló:", err.message);
  process.exit(1);
});
