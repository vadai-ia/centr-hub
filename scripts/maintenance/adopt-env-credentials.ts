/* eslint-disable no-console */
/**
 * Materializa las credenciales que hoy viven en variables de entorno hacia el
 * Vault de UNA organización concreta.
 *
 * POR QUÉ EXISTE (paso obligatorio del deploy de 0046): los getters del Vault
 * dejaron de caer a env (fail-closed). Antes, una organización con el bag
 * vacío "funcionaba" usando `SHOPIFY_API_SECRET` / `WHAAPY_API_KEY` /
 * `WHAAPY_POSTVENTA_API_KEY` globales — y esa comodidad es justo lo que hace
 * que una SEGUNDA organización, sin credenciales propias, autentique en
 * silencio contra la tienda y el Whaapy de la primera. Con el fallback
 * retirado, una organización que dependía de env queda sin credenciales hasta
 * que se ejecute esto (o hasta que el admin las capture en Admin →
 * Integraciones, que es el camino normal de aquí en adelante).
 *
 * Uso:
 *   npm run maintenance:adopt-env-credentials -- --org-slug centr --dry-run
 *   npm run maintenance:adopt-env-credentials -- --org-slug centr
 *
 * Idempotente y NO destructivo: solo escribe las credenciales que faltan en
 * Vault. Una credencial ya presente NUNCA se sobrescribe con la de env (el
 * Vault es la fuente de verdad; env es solo el origen histórico).
 *
 * El `webhook_secret` de Whaapy no está en env por diseño (Whaapy lo muestra
 * una sola vez al crear el webhook) — este script no puede recuperarlo. Si
 * falta, se reporta para capturarlo desde la pantalla.
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import {
  getVaultCredentialPresence,
  storeProviderCredentials,
  type VaultProviderKey,
} from "@/lib/vault";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

interface CliArgs {
  orgSlug: string;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let orgSlug: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (arg === "--dry-run") dryRun = true;
  }
  if (!orgSlug) {
    console.error(
      "Uso: tsx adopt-env-credentials.ts --org-slug <slug> [--dry-run]",
    );
    process.exit(2);
  }
  return { orgSlug, dryRun };
}

interface Candidate {
  provider: VaultProviderKey;
  key: string;
  envVar: string;
  value: string | undefined;
}

function collectCandidates(): Candidate[] {
  const env = process.env;
  return [
    {
      provider: "shopify",
      key: "client_id",
      envVar: "SHOPIFY_API_KEY",
      value: env.SHOPIFY_API_KEY,
    },
    {
      provider: "shopify",
      key: "client_secret",
      envVar: "SHOPIFY_API_SECRET",
      // En el flujo del Dev Dashboard, el secret del webhook ES el Client
      // Secret: si solo está poblada SHOPIFY_WEBHOOK_SECRET, sirve igual.
      value: env.SHOPIFY_API_SECRET || env.SHOPIFY_WEBHOOK_SECRET,
    },
    {
      provider: "whaapy_venta",
      key: "api_key",
      envVar: "WHAAPY_API_KEY",
      value: env.WHAAPY_API_KEY,
    },
    {
      provider: "whaapy_postventa",
      key: "api_key",
      envVar: "WHAAPY_POSTVENTA_API_KEY",
      value: env.WHAAPY_POSTVENTA_API_KEY,
    },
  ];
}

/** Nunca se imprime una credencial: solo su longitud y últimos 4. */
function describe(value: string): string {
  return `${value.length} chars, ••••${value.slice(-4)}`;
}

async function main() {
  const args = parseArgs();

  const org = await getOrganizationBySlug(args.orgSlug);
  if (!org) {
    console.error(`org ${args.orgSlug} no encontrada`);
    process.exit(1);
  }
  console.log(`Organización: ${org.name} (${org.id})`);
  console.log(args.dryRun ? "MODO DRY-RUN — no se escribe nada.\n" : "");

  const presence = await getVaultCredentialPresence(org.id);
  const candidates = collectCandidates();

  // Estado ACTUAL del Vault antes de tocar nada — es el chequeo previo al
  // deploy: cualquier credencial requerida que no aparezca aquí deja su
  // integración muda en cuanto los getters dejan de caer a env.
  console.log("Vault actual (solo nombres de credencial, nunca valores):");
  for (const [provider, keys] of Object.entries(presence)) {
    console.log(`  ${provider}: ${keys.length ? keys.join(", ") : "— vacío —"}`);
  }
  console.log("");

  const toWrite = new Map<VaultProviderKey, Record<string, string>>();
  let skippedPresent = 0;
  let skippedNoEnv = 0;

  for (const c of candidates) {
    const already = (presence[c.provider] ?? []).includes(c.key);
    if (already) {
      console.log(`[skip ] ${c.provider}.${c.key} — ya está en Vault (no se pisa)`);
      skippedPresent++;
      continue;
    }
    if (!c.value || !c.value.trim()) {
      console.log(`[falta] ${c.provider}.${c.key} — ${c.envVar} vacía en el entorno`);
      skippedNoEnv++;
      continue;
    }
    console.log(`[write] ${c.provider}.${c.key} ← ${c.envVar} (${describe(c.value)})`);
    const bag = toWrite.get(c.provider) ?? {};
    bag[c.key] = c.value.trim();
    toWrite.set(c.provider, bag);
  }

  if (!args.dryRun) {
    for (const [provider, values] of Array.from(toWrite.entries())) {
      await storeProviderCredentials(org.id, provider, values);
    }
  }

  const written = Array.from(toWrite.values()).reduce(
    (acc, v) => acc + Object.keys(v).length,
    0,
  );
  console.log(
    `\nResumen: ${written} credencial(es) ${args.dryRun ? "a escribir" : "escritas"}, ` +
      `${skippedPresent} ya presentes, ${skippedNoEnv} sin valor en el entorno.`,
  );
  console.log(
    "\nLo que este script NO puede recuperar (Whaapy los muestra una sola vez):\n" +
      "  · whaapy.webhook_secret\n" +
      "  · whaapy_postventa.webhook_secret / inbound_token\n" +
      "Captúralos desde Admin → Integraciones. Verifica el estado final ahí mismo.",
  );
}

main().catch((err: Error) => {
  console.error("adopt-env-credentials falló:", err.message);
  process.exit(1);
});
