/* eslint-disable no-console */
/**
 * Diagnóstico (lectura pura): lista las etapas del funnel del Whaapy de
 * Post-venta vía `GET /funnel/v1/stages`, con su UUID, nombre y posición.
 *
 * Sirve para (a) validar que las 3 etapas esperadas existen con el nombre
 * EXACTO que la integración resuelve (Entregado, Caso Problemático, Caso
 * Resuelto) y (b) ver los UUID a los que la API `move` apuntará.
 *
 * Invariante de los scripts inspect-*: NO escribe a BD propia, NO modifica
 * nada en Whaapy. Reusa el api_key del Vault (namespace whaapy_postventa,
 * con fallback a WHAAPY_POSTVENTA_API_KEY).
 *
 * Uso:
 *   npm run whaapy:inspect-postventa-stages -- --org-slug centr
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getWhaapyPostventaApiKey } from "@/lib/vault";
import { WHAAPY_API_BASE } from "@/lib/whaapy/config";
import { WHAAPY_POSTVENTA_STAGE_NAMES } from "@/lib/whaapy-postventa/config";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

interface WhaapyStage {
  id?: string;
  name?: string;
  position?: number;
  color?: string;
  contact_count?: number;
}

async function main(): Promise<void> {
  const slug = arg("--org-slug", "centr")!;
  const org = await getOrganizationBySlug(slug);
  if (!org) {
    console.error(`org ${slug} no encontrada`);
    process.exit(1);
  }
  console.log(`org: ${org.name} (${org.id})`);
  console.log(`base: ${WHAAPY_API_BASE}`);

  const apiKey = await getWhaapyPostventaApiKey(org.id);
  console.log(`api_key Post-venta obtenida del Vault (len=${apiKey.length})`);

  const url = `${WHAAPY_API_BASE}/funnel/v1/stages`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  const rawText = await res.text();
  console.log(`\nHTTP ${res.status} (ok=${res.ok})`);

  let parsed: unknown = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch (err) {
    console.log("--- JSON.parse error ---");
    console.log((err as Error).message);
    console.log(rawText.slice(0, 2000));
    process.exit(1);
  }

  const stages: WhaapyStage[] = Array.isArray(
    (parsed as { stages?: unknown })?.stages,
  )
    ? ((parsed as { stages: WhaapyStage[] }).stages)
    : [];

  console.log(`\n=== Etapas (${stages.length}) ===`);
  for (const s of stages) {
    console.log(
      `  pos=${s.position ?? "?"}  "${s.name ?? "?"}"  id=${s.id ?? "?"}` +
        (typeof s.contact_count === "number" ? `  contactos=${s.contact_count}` : ""),
    );
  }

  // Verificación de que las 3 etapas de la integración existen por nombre.
  const byName = new Map(stages.map((s) => [s.name ?? "", s]));
  console.log(`\n=== Match de nombres esperados por la integración ===`);
  for (const [key, name] of Object.entries(WHAAPY_POSTVENTA_STAGE_NAMES)) {
    const found = byName.get(name);
    console.log(
      `  ${key.padEnd(18)} "${name}" → ${found?.id ? `OK ${found.id}` : "NO ENCONTRADA ⚠"}`,
    );
  }
}

main().catch((err: Error) => {
  console.error("inspect-postventa-stages falló:", err.message);
  if ((err as unknown as { body?: unknown }).body) {
    console.dir((err as unknown as { body: unknown }).body, { depth: null });
  }
  process.exit(1);
});
