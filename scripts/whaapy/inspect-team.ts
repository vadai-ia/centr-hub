/* eslint-disable no-console */
/**
 * Script de diagnóstico (lectura pura): imprime la response REAL de Whaapy
 * para el EQUIPO de agentes y cómo la interpreta `parseWhaapyTeamResponse`.
 *
 * Motivo: la forma exacta de `/team/v1` no está confirmada contra captura real.
 * Este script prueba varios paths candidatos y muestra raw JSON + top-level keys
 * + el resultado del parser tolerante, para endurecer `lib/whaapy/team.ts` si
 * la forma real difiere. NO persiste nada. NO modifica el recurso del proveedor.
 *
 * Uso:
 *   npm run whaapy:inspect-team -- --org-slug centr
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getWhaapyApiKey } from "@/lib/vault";
import { WHAAPY_API_BASE } from "@/lib/whaapy/config";
import { parseWhaapyTeamResponse } from "@/lib/whaapy/team";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function parseArgs(): { orgSlug: string } {
  const argv = process.argv.slice(2);
  let orgSlug: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
  }
  if (!orgSlug) {
    console.error("Uso: tsx inspect-team.ts --org-slug <slug>");
    process.exit(2);
  }
  return { orgSlug };
}

async function probe(apiKey: string, path: string): Promise<void> {
  const url = `${WHAAPY_API_BASE}${path}`;
  console.log("");
  console.log(`===== GET ${path} =====`);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    const raw = await res.text();
    console.log(`HTTP status: ${res.status} (ok=${res.ok})`);
    console.log("--- raw body (first 4000 chars) ---");
    console.log(raw.slice(0, 4000));
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.log(`--- JSON.parse error --- ${(err as Error).message}`);
      return;
    }
    if (parsed && typeof parsed === "object") {
      console.log("--- top-level keys ---");
      console.log(Array.isArray(parsed) ? "(array)" : Object.keys(parsed as Record<string, unknown>));
    }
    const agents = parseWhaapyTeamResponse(parsed);
    console.log(`--- parseWhaapyTeamResponse → ${agents.length} agentes ---`);
    console.dir(agents, { depth: null });
  } catch (err) {
    console.log(`fetch error: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const { orgSlug } = parseArgs();
  const org = await getOrganizationBySlug(orgSlug);
  if (!org) {
    console.error(`org ${orgSlug} no encontrada`);
    process.exit(1);
  }
  console.log(`org: ${org.name} (${org.id})`);
  console.log(`base: ${WHAAPY_API_BASE}`);
  const apiKey = await getWhaapyApiKey(org.id);
  console.log(`api_key obtenida del Vault (len=${apiKey.length})`);

  // Path documentado + alternos por si la versión difiere.
  for (const path of ["/team/v1", "/team", "/agents/v1", "/agents"]) {
    await probe(apiKey, path);
  }
}

main().catch((err: Error) => {
  console.error("inspect-team falló:", err.message);
  process.exit(1);
});
