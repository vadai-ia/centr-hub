/* eslint-disable no-console */
/**
 * Correctivo — colapsa los avisos de SISTEMA repetidos en la campanita.
 *
 * El problema medido en producción: 2109 avisos acumulados, de los cuales
 * 678 eran el MISMO fallo de sincronización repetido en Centr Colombia (una
 * organización que no tiene Whaapy conectado, así que ningún reintento iba a
 * arreglarlo). Una campanita con cientos de avisos es una campanita que nadie
 * abre — y ahí viven los recordatorios de tareas, que sí hay que atender.
 *
 * Qué hace: de cada grupo de avisos de sistema equivalentes (misma persona,
 * mismo tipo, misma función de origen) **conserva el más reciente** y descarta
 * el resto. No borra: los marca `dismissed`, que es lo que hace el usuario al
 * cerrarlos. Reversible y sin perder la cuenta real — cada fallo quedó
 * registrado en `audit_log`, que es donde vive el historial.
 *
 * Qué NO toca, a propósito:
 *   - Avisos operativos (`follow_up`, `task_due_reminder`, …): son trabajo de
 *     una persona sobre una tarjeta concreta, no ruido repetido. Colapsarlos
 *     haría desaparecer pendientes que nadie atendió.
 *   - Avisos ya atendidos o descartados.
 *
 * Uso:
 *   npm run maintenance:prune-system-notifications -- --org-slug centr-colombia
 *   npm run maintenance:prune-system-notifications -- --org-slug centr-colombia --apply
 *   npm run maintenance:prune-system-notifications -- --todas --apply
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { fetchAllPaged, type RangeableQuery } from "@/lib/db/paginate";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

/**
 * Tipos que SON ruido de sistema: el mismo problema re-anunciado. Los
 * operativos quedan fuera — un `follow_up` por cada tarjeta no es repetición.
 */
const TIPOS_SISTEMA = new Set([
  "system_failure_dlq",
  "whaapy_unhandled_event_recurring",
]);

interface Fila {
  id: string;
  organization_id: string;
  user_id: string;
  notification_type: string;
  status: string;
  created_at: string;
  origin_reference: { function_id?: string; topic?: string } | null;
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

  const filas = await fetchAllPaged<Fila>(
    () => {
      let q = sb
        .from("notifications")
        .select("id, organization_id, user_id, notification_type, status, created_at, origin_reference")
        .eq("status", "pending")
        .in("notification_type", Array.from(TIPOS_SISTEMA))
        .order("created_at", { ascending: false });
      if (orgId) q = q.eq("organization_id", orgId);
      return q as unknown as RangeableQuery;
    },
  );

  // Agrupar por lo que define "es el mismo aviso": persona + tipo + origen.
  const grupos = new Map<string, Fila[]>();
  for (const f of filas) {
    const origen = f.origin_reference?.function_id ?? f.origin_reference?.topic ?? "—";
    const k = `${f.organization_id}|${f.user_id}|${f.notification_type}|${origen}`;
    const g = grupos.get(k);
    if (g) g.push(f);
    else grupos.set(k, [f]);
  }

  const aDescartar: string[] = [];
  for (const g of Array.from(grupos.values())) {
    // `filas` viene de más reciente a más viejo: el primero se conserva.
    aDescartar.push(...g.slice(1).map((f) => f.id));
  }

  console.log(`Avisos de sistema pendientes: ${filas.length}`);
  console.log(`Grupos distintos (lo que quedaría): ${grupos.size}`);
  console.log(`A descartar: ${aDescartar.length}`);

  const resumen = new Map<string, number>();
  for (const [k, g] of Array.from(grupos.entries())) {
    if (g.length <= 1) continue;
    const [, , tipo, origen] = k.split("|");
    const etiqueta = `${tipo} · ${origen}`;
    resumen.set(etiqueta, (resumen.get(etiqueta) ?? 0) + g.length - 1);
  }
  for (const [k, v] of Array.from(resumen.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(5)}  ${k}`);
  }

  if (aDescartar.length === 0) return;
  if (!apply) {
    console.log("\n(dry-run — no se tocó nada). Repite con --apply.");
    return;
  }

  // En lotes: un `.in()` con cientos de ids revienta el límite de la URL.
  const LOTE = 200;
  let hechos = 0;
  for (let i = 0; i < aDescartar.length; i += LOTE) {
    const lote = aDescartar.slice(i, i + LOTE);
    const { error } = await sb
      .from("notifications")
      .update({ status: "dismissed" })
      .in("id", lote)
      // Re-filtra por pendiente: si alguien lo atendió entre la lectura y la
      // escritura, su acción manda.
      .eq("status", "pending");
    if (error) throw error;
    hechos += lote.length;
  }
  console.log(`\nListo: ${hechos} avisos descartados. Quedan ${grupos.size} abiertos.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
