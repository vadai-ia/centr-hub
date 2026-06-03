/* eslint-disable no-console */
/**
 * Harness de CHECKPOINT M7.2 — re-entrega (duplicado) de la
 * completación de un Draft Order para validar la IDEMPOTENCIA del
 * trigger F1→F2 contra producción.
 *
 * Reproduce fielmente una re-entrega de Shopify:
 *   - Descubre la callback URL real desde las webhook subscriptions
 *     del shop (no se hardcodea nada).
 *   - Firma el payload con el Client Secret (HMAC-SHA256 base64), igual
 *     que Shopify.
 *   - Usa un X-Shopify-Webhook-Id NUEVO (la re-entrega real tras la
 *     ventana de dedup de 24h trae un id distinto) — así el evento
 *     atraviesa la capa de dedup de Redis y llega al worker + RPC,
 *     que es justo lo que queremos ejercitar.
 *   - `updated_at` se fija ANTERIOR al last_modified_at de la F1 (una
 *     re-entrega real trae el timestamp de completación original, que
 *     el trigger ya superó al bumpear la F1). Esto cae en la rama LWW
 *     "stale": NO sobreescribe campos de la F1, pero igual dispara el
 *     trigger (maybeFireF1ToF2 está en el path stale). Sin clobber.
 *
 * Resultado esperado: el RPC retorna skipped/child_already_exists; la
 * F1 conserva UNA sola hija; audit_log = trigger_f1_f2_skipped.
 *
 * Uso:
 *   npx tsx scripts/shopify/harness-replay-draft-completion.ts \
 *     --org-slug centr \
 *     --opp-id b0698540-e5b5-4831-9745-c64baf22bfd1 \
 *     --order-id 7059698581780
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { withTenantContext } from "@/lib/tenant/context";
import { getShopifyWebhookSecret } from "@/lib/vault";
import { shopifyGraphql } from "@/lib/shopify/admin-client";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function parseArgs() {
  const argv = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    const v = argv[i + 1];
    if (k && v) out[k] = v;
  }
  if (!out["org-slug"] || !out["opp-id"] || !out["order-id"]) {
    console.error(
      "Uso: tsx harness-replay-draft-completion.ts --org-slug <s> --opp-id <uuid> --order-id <shopify_order_id>",
    );
    process.exit(2);
  }
  return out;
}

async function resolveDraftOrdersUpdateCallback(opts: {
  organizationId: string;
  shopDomain: string;
}): Promise<string> {
  const query = /* GraphQL */ `
    query Subs($first: Int!) {
      webhookSubscriptions(first: $first) {
        edges { node {
          topic
          endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
        } }
      }
    }
  `;
  const data = await shopifyGraphql<{
    webhookSubscriptions: {
      edges: Array<{ node: { topic: string; endpoint: { callbackUrl?: string } } }>;
    };
  }>(opts, query, { first: 100 });
  const sub = data.webhookSubscriptions.edges.find(
    (e) => e.node.topic.toUpperCase() === "DRAFT_ORDERS_UPDATE",
  );
  const url = sub?.node.endpoint?.callbackUrl;
  if (!url) throw new Error("no se encontró subscription draft_orders/update con callbackUrl");
  return url;
}

async function main() {
  const args = parseArgs();
  const oppId = args["opp-id"] as UUID;
  const orderId = args["order-id"];

  const org = await getOrganizationBySlug(args["org-slug"]);
  if (!org) { console.error(`org ${args["org-slug"]} no encontrada`); process.exit(1); }
  if (!org.shopify_store_domain) { console.error("org sin shopify_store_domain"); process.exit(1); }
  const shopDomain = org.shopify_store_domain;

  await withTenantContext(org.id as UUID, async () => {
    const supabase = getSupabaseAdminClient();

    // --- Pre-estado ---
    const { data: f1, error: f1Err } = await supabase
      .from("opportunities")
      .select("id, funnel, stage_id, last_modified_at, currency, shopify_draft_order_id, shopify_order_id, won_at, parent_opportunity_id")
      .eq("id", oppId)
      .eq("organization_id", org.id)
      .maybeSingle();
    if (f1Err) throw f1Err;
    if (!f1) { console.error(`F1 ${oppId} no encontrada`); process.exit(1); }
    const draftId = f1.shopify_draft_order_id;
    if (!draftId) { console.error("F1 sin shopify_draft_order_id"); process.exit(1); }

    const { data: childrenBefore } = await supabase
      .from("opportunities")
      .select("id, created_at")
      .eq("organization_id", org.id)
      .eq("parent_opportunity_id", oppId)
      .eq("funnel", "post_venta");

    console.log("=== PRE-ESTADO ===");
    console.log("F1:", { id: f1.id, draft_order_id: draftId, shopify_order_id: f1.shopify_order_id, won_at: f1.won_at, last_modified_at: f1.last_modified_at });
    console.log("Hijas post-venta:", (childrenBefore ?? []).length, (childrenBefore ?? []).map((c) => c.id));

    // --- Construir payload (updated_at stale → sin clobber) ---
    const staleTs = new Date(Date.parse(f1.last_modified_at) - 60_000).toISOString();
    const payload = {
      id: Number(draftId),
      status: "completed",
      completed_at: staleTs,
      updated_at: staleTs,
      created_at: new Date(Date.parse(f1.last_modified_at) - 3_600_000).toISOString(),
      order_id: Number(orderId),
      line_items: [],
      total_price: "0.00",
      subtotal_price: "0.00",
      total_tax: "0.00",
      currency: f1.currency,
    };
    const body = JSON.stringify(payload);

    // --- Firmar + descubrir endpoint real ---
    const secret = await getShopifyWebhookSecret(org.id as UUID);
    const hmac = createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("base64");
    const callbackUrl = await resolveDraftOrdersUpdateCallback({ organizationId: org.id, shopDomain });
    const freshWebhookId = `checkpoint-dup-${Date.now()}`;

    console.log("\n=== ENVÍO ===");
    console.log("callbackUrl:", callbackUrl);
    console.log("X-Shopify-Webhook-Id (fresco):", freshWebhookId);

    const res = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "draft_orders/update",
        "x-shopify-shop-domain": shopDomain,
        "x-shopify-hmac-sha256": hmac,
        "x-shopify-webhook-id": freshWebhookId,
        "x-shopify-triggered-at": new Date().toISOString(),
      },
      body,
    });
    console.log("HTTP", res.status, "| dedup:", res.headers.get("x-centrhub-dedup"), "| body:", await res.text());

    // --- Esperar procesamiento async (Inngest) ---
    console.log("\nEsperando 9s a que Inngest procese el worker...");
    await new Promise((r) => setTimeout(r, 9000));

    // --- Post-estado / verificación ---
    const { data: childrenAfter } = await supabase
      .from("opportunities")
      .select("id, created_at")
      .eq("organization_id", org.id)
      .eq("parent_opportunity_id", oppId)
      .eq("funnel", "post_venta");

    const { data: audits } = await supabase
      .from("audit_log")
      .select("event_type, payload, created_at")
      .eq("organization_id", org.id)
      .in("event_type", ["trigger_f1_f2_skipped", "trigger_f1_f2_fired", "trigger_f1_f2_failed"])
      .order("created_at", { ascending: false })
      .limit(5);

    console.log("\n=== POST-ESTADO ===");
    console.log("Hijas post-venta:", (childrenAfter ?? []).length, (childrenAfter ?? []).map((c) => c.id));
    console.log("Últimos audit trigger_f1_f2_*:");
    for (const a of audits ?? []) {
      console.log("  -", a.created_at, a.event_type, JSON.stringify(a.payload));
    }

    const beforeIds = new Set((childrenBefore ?? []).map((c) => c.id));
    const afterIds = (childrenAfter ?? []).map((c) => c.id);
    const newChildren = afterIds.filter((id) => !beforeIds.has(id));
    console.log("\n=== VEREDICTO ===");
    console.log("Hijas antes:", beforeIds.size, "| después:", afterIds.length, "| nuevas:", newChildren.length);
    if (newChildren.length === 0 && afterIds.length === 1) {
      console.log("✅ IDEMPOTENTE: no se creó hija nueva; la F1 conserva 1 sola hija.");
    } else {
      console.log("❌ REVISAR: el conteo de hijas cambió o no es 1.", { newChildren });
    }
  }, { source: "script" });
}

main().catch((err: Error) => {
  console.error("harness falló:", err.message);
  process.exit(1);
});
