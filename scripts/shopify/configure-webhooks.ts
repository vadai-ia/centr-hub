/* eslint-disable no-console */
/**
 * Script para registrar / actualizar los 12 webhook subscriptions
 * de Shopify vía GraphQL Admin API.
 *
 * Uso:
 *   npx tsx scripts/shopify/configure-webhooks.ts \
 *       --org-slug centr \
 *       --callback-url https://<tunnel-o-vercel>/api/webhooks/shopify
 *
 * - Reconcilia: lista los webhooks actuales del shop, da de baja
 *   los que apunten a callbacks distintos para los topics que
 *   gestionamos, y crea/actualiza los 12 que necesitamos.
 * - Idempotente: re-ejecutable cualquier número de veces.
 *
 * Variables de entorno requeridas (provienen de .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   SHOPIFY_API_KEY, SHOPIFY_API_SECRET.
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import {
  shopifyGraphql,
  type GraphqlResponse,
} from "@/lib/shopify/admin-client";
import { SHOPIFY_SUBSCRIBED_TOPICS } from "@/lib/inngest/client";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

interface CliArgs {
  orgSlug: string;
  callbackUrl: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let orgSlug: string | null = null;
  let callbackUrl: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (arg === "--callback-url") callbackUrl = argv[++i] ?? null;
  }
  if (!orgSlug || !callbackUrl) {
    console.error(
      "Uso: tsx configure-webhooks.ts --org-slug <slug> --callback-url <url>",
    );
    process.exit(2);
  }
  return { orgSlug, callbackUrl };
}

function topicToGraphqlEnum(topic: string): string {
  // Shopify GraphQL espera topics en SHOUTY_SNAKE.
  // Ej: "customers/update" → "CUSTOMERS_UPDATE"
  return topic.toUpperCase().replace(/\//g, "_");
}

interface ExistingSubscription {
  id: string;
  topic: string;
  callbackUrl: string | null;
}

async function listWebhookSubscriptions(opts: {
  organizationId: string;
  shopDomain: string;
}): Promise<ExistingSubscription[]> {
  const query = /* GraphQL */ `
    query Subscriptions($first: Int!) {
      webhookSubscriptions(first: $first) {
        edges {
          node {
            id
            topic
            endpoint {
              __typename
              ... on WebhookHttpEndpoint {
                callbackUrl
              }
            }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphql<{
    webhookSubscriptions: {
      edges: Array<{
        node: {
          id: string;
          topic: string;
          endpoint: { __typename: string; callbackUrl?: string };
        };
      }>;
    };
  }>(opts, query, { first: 100 });
  return data.webhookSubscriptions.edges.map((e) => ({
    id: e.node.id,
    topic: e.node.topic,
    callbackUrl: e.node.endpoint?.callbackUrl ?? null,
  }));
}

interface UserError {
  field: string[] | null;
  message: string;
}

async function createWebhookSubscription(opts: {
  organizationId: string;
  shopDomain: string;
  topic: string;
  callbackUrl: string;
}): Promise<void> {
  const mutation = /* GraphQL */ `
    mutation Create($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
        webhookSubscription { id }
        userErrors { field message }
      }
    }
  `;
  type Result = {
    webhookSubscriptionCreate: {
      webhookSubscription: { id: string } | null;
      userErrors: UserError[];
    };
  };
  const data = await shopifyGraphql<Result>(opts, mutation, {
    topic: topicToGraphqlEnum(opts.topic),
    sub: { callbackUrl: opts.callbackUrl, format: "JSON" },
  });
  const errs = data.webhookSubscriptionCreate.userErrors;
  if (errs && errs.length > 0) {
    throw new Error(
      `create_webhook_failed [${opts.topic}]: ${errs.map((e) => e.message).join("; ")}`,
    );
  }
}

async function updateWebhookSubscription(opts: {
  organizationId: string;
  shopDomain: string;
  id: string;
  callbackUrl: string;
}): Promise<void> {
  const mutation = /* GraphQL */ `
    mutation Update($id: ID!, $sub: WebhookSubscriptionInput!) {
      webhookSubscriptionUpdate(id: $id, webhookSubscription: $sub) {
        webhookSubscription { id }
        userErrors { field message }
      }
    }
  `;
  type Result = {
    webhookSubscriptionUpdate: {
      webhookSubscription: { id: string } | null;
      userErrors: UserError[];
    };
  };
  const data = await shopifyGraphql<Result>(opts, mutation, {
    id: opts.id,
    sub: { callbackUrl: opts.callbackUrl, format: "JSON" },
  });
  const errs = data.webhookSubscriptionUpdate.userErrors;
  if (errs && errs.length > 0) {
    throw new Error(
      `update_webhook_failed: ${errs.map((e) => e.message).join("; ")}`,
    );
  }
}

async function main() {
  const args = parseArgs();
  const supabase = getSupabaseAdminClient();
  void supabase; // forzar init temprano de env vars

  const org = await getOrganizationBySlug(args.orgSlug);
  if (!org) {
    console.error(`org ${args.orgSlug} no encontrada`);
    process.exit(1);
  }
  if (!org.shopify_store_domain) {
    console.error(`org ${args.orgSlug} no tiene shopify_store_domain`);
    process.exit(1);
  }
  const ctx = { organizationId: org.id, shopDomain: org.shopify_store_domain };

  console.log(`Configurando webhooks para ${org.name} (${org.shopify_store_domain})`);
  console.log(`Callback URL: ${args.callbackUrl}`);

  const existing = await listWebhookSubscriptions(ctx);
  const existingByTopic = new Map<string, ExistingSubscription>();
  for (const e of existing) existingByTopic.set(e.topic.toLowerCase(), e);

  for (const topic of SHOPIFY_SUBSCRIBED_TOPICS) {
    const gqlTopic = topicToGraphqlEnum(topic).toLowerCase();
    const current = existingByTopic.get(gqlTopic);
    if (!current) {
      console.log(`[create] ${topic}`);
      await createWebhookSubscription({
        ...ctx,
        topic,
        callbackUrl: args.callbackUrl,
      });
      continue;
    }
    if (current.callbackUrl === args.callbackUrl) {
      console.log(`[skip   ] ${topic} (ya apunta a callback correcto)`);
      continue;
    }
    console.log(
      `[update ] ${topic} (callback antiguo: ${current.callbackUrl ?? "n/a"})`,
    );
    await updateWebhookSubscription({
      ...ctx,
      id: current.id,
      callbackUrl: args.callbackUrl,
    });
  }

  console.log("Webhook subscriptions reconciliados.");
}

main().catch((err: Error) => {
  console.error("configure-webhooks falló:", err.message);
  if ((err as unknown as { body?: unknown }).body) {
    console.error("body:", (err as unknown as { body: unknown }).body);
  }
  process.exit(1);
});
