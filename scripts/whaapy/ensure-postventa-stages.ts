/* eslint-disable no-console */
/**
 * Crea, si faltan, las 3 etapas que la integración de Post-venta resuelve POR
 * NOMBRE en el funnel del Whaapy de Post-venta de una organización.
 *
 * Por qué existe: el match de etapas es igualdad EXACTA de string (ver
 * `resolvePostventaStageIdByKey`). Una org recién conectada trae el funnel
 * default de Whaapy (Nuevo/Contactado/Calificado/Cliente), así que "Probar
 * conexión" falla con "faltan etapas" aunque la credencial sea correcta. Este
 * script cierra ese hueco sin que el operador tenga que teclear los acentos a
 * mano en el dashboard.
 *
 * ADITIVO por diseño: NUNCA renombra ni borra etapas existentes. Si una etapa
 * esperada ya existe con el nombre exacto, la deja intacta. Las etapas ajenas
 * (las default de Whaapy, o las que la org use para otra cosa) no se tocan:
 * sobran sin estorbar, porque la resolución es por nombre.
 *
 * Idempotente: correrlo dos veces no crea duplicados.
 *
 * Uso:
 *   npm run whaapy:ensure-postventa-stages -- --org-slug rustr --dry-run
 *   npm run whaapy:ensure-postventa-stages -- --org-slug rustr
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
  contact_count?: number;
}

/** Color por etapa: verde = entregado, rojo = problema, azul = resuelto. */
const STAGE_COLORS: Record<string, string> = {
  entregado: "#10b981",
  casoProblematico: "#ef4444",
  casoResuelto: "#3b82f6",
};

async function listStages(apiKey: string): Promise<WhaapyStage[]> {
  const res = await fetch(`${WHAAPY_API_BASE}/funnel/v1/stages`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET /funnel/v1/stages → HTTP ${res.status}: ${text.slice(0, 500)}`);
  const parsed = text ? (JSON.parse(text) as { stages?: WhaapyStage[] }) : null;
  return Array.isArray(parsed?.stages) ? parsed.stages : [];
}

async function createStage(apiKey: string, name: string, color: string): Promise<WhaapyStage> {
  const res = await fetch(`${WHAAPY_API_BASE}/funnel/v1/stages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, color }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /funnel/v1/stages "${name}" → HTTP ${res.status}: ${text.slice(0, 500)}`);
  const parsed = text ? (JSON.parse(text) as { stage?: WhaapyStage }) : null;
  return parsed?.stage ?? {};
}

async function main(): Promise<void> {
  const slug = arg("--org-slug");
  const dryRun = process.argv.includes("--dry-run");
  if (!slug) {
    console.error("Uso: --org-slug <slug> [--dry-run]");
    process.exit(1);
  }
  const org = await getOrganizationBySlug(slug);
  if (!org) {
    console.error(`org ${slug} no encontrada`);
    process.exit(1);
  }
  console.log(`org: ${org.name} (${org.id})`);
  console.log(`base: ${WHAAPY_API_BASE}`);
  console.log(dryRun ? "modo: DRY-RUN (no escribe nada)\n" : "modo: EJECUCIÓN REAL\n");

  const apiKey = await getWhaapyPostventaApiKey(org.id);

  const before = await listStages(apiKey);
  console.log(`=== Etapas actuales (${before.length}) ===`);
  for (const s of before) {
    console.log(
      `  pos=${s.position ?? "?"}  "${s.name ?? "?"}"  id=${s.id ?? "?"}` +
        (typeof s.contact_count === "number" ? `  contactos=${s.contact_count}` : ""),
    );
  }

  const existing = new Set(before.map((s) => s.name ?? ""));
  const plan = Object.entries(WHAAPY_POSTVENTA_STAGE_NAMES).map(([key, name]) => ({
    key,
    name,
    color: STAGE_COLORS[key] ?? "#6366f1",
    missing: !existing.has(name),
  }));

  console.log(`\n=== Plan ===`);
  for (const p of plan) {
    console.log(`  ${p.key.padEnd(18)} "${p.name}" → ${p.missing ? `CREAR (${p.color})` : "ya existe, se deja intacta"}`);
  }

  const toCreate = plan.filter((p) => p.missing);
  if (toCreate.length === 0) {
    console.log("\nNada que hacer: las 3 etapas ya existen con el nombre exacto.");
    return;
  }
  if (dryRun) {
    console.log(`\nDRY-RUN: se crearían ${toCreate.length} etapa(s). Repetir sin --dry-run para aplicar.`);
    return;
  }

  console.log("");
  for (const p of toCreate) {
    const created = await createStage(apiKey, p.name, p.color);
    console.log(`  creada "${p.name}" → id=${created.id ?? "?"} pos=${created.position ?? "?"}`);
  }

  const after = await listStages(apiKey);
  const names = new Set(after.map((s) => s.name ?? ""));
  const stillMissing = Object.values(WHAAPY_POSTVENTA_STAGE_NAMES).filter((n) => !names.has(n));
  console.log(`\n=== Verificación post-escritura (${after.length} etapas) ===`);
  for (const [key, name] of Object.entries(WHAAPY_POSTVENTA_STAGE_NAMES)) {
    const found = after.find((s) => s.name === name);
    console.log(`  ${key.padEnd(18)} "${name}" → ${found?.id ? `OK ${found.id}` : "NO ENCONTRADA ⚠"}`);
  }
  if (stillMissing.length > 0) {
    console.error(`\nFALLÓ: siguen faltando ${stillMissing.join(", ")}`);
    process.exit(1);
  }
  console.log("\nListo. 'Probar conexión' en Admin → Integraciones debe pasar a verde.");
}

main().catch((err: Error) => {
  console.error("ensure-postventa-stages falló:", err.message);
  process.exit(1);
});
