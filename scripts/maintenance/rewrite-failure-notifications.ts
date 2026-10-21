/* eslint-disable no-console */
/**
 * Correctivo — reescribe en castellano los avisos de fallo YA creados.
 *
 * La traducción (`describeSystemFailure`) solo afecta a los avisos nuevos:
 * las filas que ya estaban en la base siguen mostrando el volcado técnico
 * —`{"code":"23505","details":"Key (organization_id, …) already exists"}` y
 * `Revisar logs Inngest`— a gente que no sabe qué es ni qué hacer con él.
 *
 * Usa la MISMA función que el DLQ, así que lo reescrito es idéntico a lo que
 * se generaría hoy. El error crudo NO se toca: sigue en `origin_reference`,
 * que es de donde se lee para traducirlo y donde se diagnostica.
 *
 * Idempotente: correrlo dos veces deja el mismo texto.
 *
 * Uso:
 *   npm run maintenance:rewrite-failure-notifications -- --todas
 *   npm run maintenance:rewrite-failure-notifications -- --todas --apply
 *   npm run maintenance:rewrite-failure-notifications -- --org-slug centr --apply
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { fetchAllPaged, type RangeableQuery } from "@/lib/db/paginate";
import { describeSystemFailure } from "@/lib/services/failure-message";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

interface Fila {
  id: string;
  title: string;
  message: string;
  status: string;
  origin_reference: { function_id?: string; error?: string } | null;
}

async function main() {
  const slug = arg("org-slug");
  const todas = process.argv.includes("--todas");
  const apply = process.argv.includes("--apply");
  if (!slug && !todas) {
    console.error("Falta --org-slug <slug> (o --todas).");
    process.exit(1);
  }

  const sb = getSupabaseAdminClient();
  let orgId: string | null = null;
  if (slug) {
    const org = await getOrganizationBySlug(slug);
    if (!org) {
      console.error(`No existe la organización "${slug}".`);
      process.exit(1);
    }
    orgId = org.id;
  }

  const filas = await fetchAllPaged<Fila>(() => {
    let q = sb
      .from("notifications")
      .select("id, title, message, status, origin_reference")
      .eq("notification_type", "system_failure_dlq")
      // También los ya descartados: si alguien revisa el histórico, debería
      // leer lo mismo que vería hoy.
      .order("created_at", { ascending: false });
    if (orgId) q = q.eq("organization_id", orgId);
    return q as unknown as RangeableQuery;
  });

  const cambios: Array<{ id: string; title: string; message: string }> = [];
  let sinDatos = 0;
  for (const f of filas) {
    const functionId = f.origin_reference?.function_id;
    const errorMessage = f.origin_reference?.error;
    if (!functionId || typeof errorMessage !== "string") {
      // Sin el error crudo no hay nada que traducir. Se deja como está: un
      // texto feo es mejor que uno inventado.
      sinDatos += 1;
      continue;
    }
    const copy = describeSystemFailure({ functionId, errorMessage });
    if (copy.title === f.title && copy.message === f.message) continue;
    cambios.push({ id: f.id, title: copy.title, message: copy.message });
  }

  console.log(`Avisos de fallo encontrados: ${filas.length}`);
  console.log(`A reescribir: ${cambios.length}`);
  if (sinDatos > 0) {
    console.log(`Sin error guardado (se dejan como están): ${sinDatos}`);
  }

  const muestra = cambios.slice(0, 3);
  for (const c of muestra) {
    const antes = filas.find((f) => f.id === c.id)!;
    console.log(`\n  ANTES: ${antes.message.slice(0, 110)}…`);
    console.log(`  AHORA: ${c.title} — ${c.message}`);
  }

  if (cambios.length === 0) return;
  if (!apply) {
    console.log("\n(dry-run — no se tocó nada). Repite con --apply.");
    return;
  }

  let hechos = 0;
  for (const c of cambios) {
    const { error } = await sb
      .from("notifications")
      .update({ title: c.title, message: c.message })
      .eq("id", c.id);
    if (error) throw error;
    hechos += 1;
  }
  console.log(`\nListo: ${hechos} avisos reescritos.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
