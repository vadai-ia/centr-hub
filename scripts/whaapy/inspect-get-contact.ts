/* eslint-disable no-console */
/**
 * Script de diagnóstico: comparar la response REAL de Whaapy
 * `GET /contacts/{id}` vs `GET /contacts/v1/{id}` contra el schema
 * `WhaapyContactGetResponseSchema`.
 *
 * Motivo: el worker `whaapy-contact-updated` falla con Zod error
 * `expected:"string", path:["id"]` al validar la response del GET de
 * reconciliación. Hay sospecha de path inconsistente (reconcile usa
 * `/contacts/{id}`, outbound usa `/contacts/v1/{id}`).
 *
 * Uso:
 *   npm run whaapy:inspect-get-contact -- \
 *       --org-slug centr \
 *       --contact-id 1e9f3641-b882-45c5-a0e7-2c7fad2b47f5
 *
 * Output: para cada path imprime status HTTP, raw JSON, y resultado
 * de safeParse contra el schema. No persiste nada. No modifica nada.
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getWhaapyApiKey } from "@/lib/vault";
import { WHAAPY_API_BASE } from "@/lib/whaapy/config";
import { WhaapyContactGetResponseSchema } from "@/lib/whaapy/mappers";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

interface CliArgs {
  orgSlug: string;
  contactId: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let orgSlug: string | null = null;
  let contactId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (arg === "--contact-id") contactId = argv[++i] ?? null;
  }
  if (!orgSlug || !contactId) {
    console.error(
      "Uso: tsx inspect-get-contact.ts --org-slug <slug> --contact-id <whaapy_contact_id>",
    );
    process.exit(2);
  }
  return { orgSlug, contactId };
}

interface ProbeResult {
  path: string;
  status: number | null;
  ok: boolean;
  rawText: string;
  parsedJson: unknown;
  jsonParseError: string | null;
  zodOk: boolean | null;
  zodErrors: unknown;
}

async function probe(apiKey: string, path: string): Promise<ProbeResult> {
  const url = `${WHAAPY_API_BASE}${path}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    const rawText = await res.text();
    let parsedJson: unknown = null;
    let jsonParseError: string | null = null;
    try {
      parsedJson = rawText ? JSON.parse(rawText) : null;
    } catch (err) {
      jsonParseError = (err as Error).message;
    }
    let zodOk: boolean | null = null;
    let zodErrors: unknown = null;
    if (parsedJson !== null && jsonParseError === null) {
      const result = WhaapyContactGetResponseSchema.safeParse(parsedJson);
      zodOk = result.success;
      zodErrors = result.success ? null : result.error.issues;
    }
    return {
      path,
      status: res.status,
      ok: res.ok,
      rawText,
      parsedJson,
      jsonParseError,
      zodOk,
      zodErrors,
    };
  } catch (err) {
    return {
      path,
      status: null,
      ok: false,
      rawText: "",
      parsedJson: null,
      jsonParseError: (err as Error).message,
      zodOk: null,
      zodErrors: null,
    };
  }
}

function printResult(result: ProbeResult): void {
  const banner = `===== ${result.path} =====`;
  console.log("");
  console.log(banner);
  console.log(`HTTP status: ${result.status} (ok=${result.ok})`);
  console.log("--- raw body (first 4000 chars) ---");
  console.log(result.rawText.slice(0, 4000));
  if (result.rawText.length > 4000) {
    console.log(`... [truncated, total ${result.rawText.length} chars]`);
  }
  if (result.jsonParseError) {
    console.log(`--- JSON.parse error ---`);
    console.log(result.jsonParseError);
  }
  if (result.parsedJson !== null && !result.jsonParseError) {
    console.log("--- parsed JSON (pretty) ---");
    console.dir(result.parsedJson, { depth: null });
    console.log("--- top-level keys ---");
    if (typeof result.parsedJson === "object" && result.parsedJson !== null) {
      console.log(Object.keys(result.parsedJson as Record<string, unknown>));
    } else {
      console.log(`(not an object — typeof=${typeof result.parsedJson})`);
    }
  }
  console.log(`--- safeParse(WhaapyContactGetResponseSchema) ---`);
  console.log(`zod ok: ${result.zodOk}`);
  if (result.zodErrors) {
    console.log("zod issues:");
    console.dir(result.zodErrors, { depth: null });
  }
  console.log("");
}

async function main(): Promise<void> {
  const args = parseArgs();
  const org = await getOrganizationBySlug(args.orgSlug);
  if (!org) {
    console.error(`org ${args.orgSlug} no encontrada`);
    process.exit(1);
  }
  console.log(`org: ${org.name} (${org.id})`);
  console.log(`contact_id: ${args.contactId}`);
  console.log(`base: ${WHAAPY_API_BASE}`);

  const apiKey = await getWhaapyApiKey(org.id);
  console.log(`api_key obtenida del Vault (len=${apiKey.length})`);

  const pathNoVersion = `/contacts/${args.contactId}`;
  const pathWithVersion = `/contacts/v1/${args.contactId}`;

  const [a, b] = await Promise.all([
    probe(apiKey, pathNoVersion),
    probe(apiKey, pathWithVersion),
  ]);

  printResult(a);
  printResult(b);

  console.log("===== resumen =====");
  console.log(
    `${pathNoVersion}: HTTP=${a.status} zodOk=${a.zodOk}`,
  );
  console.log(
    `${pathWithVersion}: HTTP=${b.status} zodOk=${b.zodOk}`,
  );
}

main().catch((err: Error) => {
  console.error("inspect-get-contact falló:", err.message);
  if ((err as unknown as { body?: unknown }).body) {
    console.dir((err as unknown as { body: unknown }).body, { depth: null });
  }
  process.exit(1);
});
