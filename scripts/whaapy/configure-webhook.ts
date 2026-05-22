/* eslint-disable no-console */
/**
 * Script para registrar / actualizar el webhook Whaapy del proyecto.
 *
 * Uso:
 *   npm run whaapy:configure-webhook -- \
 *       --org-slug centr \
 *       --callback-url https://<tunnel-o-vercel>/api/webhooks/whaapy
 *
 * Acciones:
 *   1. Lista los webhooks existentes (`GET /user-webhooks`).
 *   2. Si ya existe uno apuntando a la callback-url destino, hace
 *      PATCH para reactivarlo y refrescar `events`.
 *   3. Si no, hace POST con todos los topics de WHAAPY_SUBSCRIBED_TOPICS.
 *   4. Persiste el `secret` devuelto por Whaapy en
 *      `organizations.vault_keys.whaapy.webhook_secret`.
 *
 * Idempotente: re-ejecutable sin duplicar. El secret SE PERSISTE
 * SIEMPRE — Whaapy lo retorna en POST inicial; en PATCH si Whaapy
 * no lo retorna, dejamos el secret anterior intacto.
 *
 * Variables de entorno requeridas (provienen de .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WHAAPY_API_KEY.
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { whaapyRest } from "@/lib/whaapy/admin-client";
import { storeWhaapyWebhookSecret } from "@/lib/vault";
import { WHAAPY_SUBSCRIBED_TOPICS } from "@/lib/inngest/client";

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
      "Uso: tsx configure-webhook.ts --org-slug <slug> --callback-url <url>",
    );
    process.exit(2);
  }
  return { orgSlug, callbackUrl };
}

interface WhaapyWebhookListItem {
  id: string;
  url: string;
  events?: string[];
  isActive?: boolean;
}

interface WhaapyWebhookCreateResponse {
  id: string;
  secret: string;
  isActive: boolean;
}

interface WhaapyWebhookPatchResponse {
  id: string;
  secret?: string;
  isActive: boolean;
}

async function main() {
  const args = parseArgs();
  const supabase = getSupabaseAdminClient();
  void supabase;

  const org = await getOrganizationBySlug(args.orgSlug);
  if (!org) {
    console.error(`org ${args.orgSlug} no encontrada`);
    process.exit(1);
  }

  console.log(`Configurando webhook Whaapy para ${org.name}`);
  console.log(`Callback URL: ${args.callbackUrl}`);

  const ctx = { organizationId: org.id };
  const list = await whaapyRest<{ data?: WhaapyWebhookListItem[] } | WhaapyWebhookListItem[]>(
    ctx,
    "GET",
    "/user-webhooks",
  );
  const webhooks = Array.isArray(list)
    ? list
    : list?.data ?? [];

  const existing = webhooks.find((w) => w.url === args.callbackUrl);

  if (existing) {
    console.log(`[update] webhook ${existing.id} ya apunta a la URL — refrescando eventos`);
    const patched = await whaapyRest<WhaapyWebhookPatchResponse>(
      ctx,
      "PATCH",
      `/user-webhooks/${existing.id}`,
      {
        events: WHAAPY_SUBSCRIBED_TOPICS,
        isActive: true,
      },
    );
    if (patched.secret) {
      await storeWhaapyWebhookSecret(org.id, patched.secret);
      console.log("[update] secret refrescado en Vault.");
    } else {
      console.log("[update] Whaapy no retornó secret en PATCH — secret previo en Vault permanece.");
    }
    console.log(`[update] webhook id=${patched.id} isActive=${patched.isActive}`);
    return;
  }

  console.log("[create] registrando webhook nuevo");
  const created = await whaapyRest<WhaapyWebhookCreateResponse>(
    ctx,
    "POST",
    "/user-webhooks",
    {
      url: args.callbackUrl,
      events: WHAAPY_SUBSCRIBED_TOPICS,
      isActive: true,
    },
  );
  if (!created.secret) {
    console.error("[create] Whaapy no devolvió secret — ABORTAR. El endpoint público no podrá verificar firmas sin él.");
    process.exit(1);
  }
  await storeWhaapyWebhookSecret(org.id, created.secret);
  console.log(`[create] webhook id=${created.id} isActive=${created.isActive} — secret persistido en Vault.`);
}

main().catch((err: Error) => {
  console.error("configure-webhook falló:", err.message);
  if ((err as unknown as { body?: unknown }).body) {
    console.dir((err as unknown as { body: unknown }).body, { depth: null });
  }
  process.exit(1);
});
