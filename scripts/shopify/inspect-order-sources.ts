/* eslint-disable no-console */
/**
 * DIAGNÓSTICO READ-ONLY. NO escribe nada.
 *
 * Responde la pregunta que el repo no puede: ¿qué es "venta orgánica" en los
 * datos reales? Shopify marca el origen de cada pedido en `source_name` (que
 * la plataforma persiste en `orders.source`): `web` = tienda online, `pos` =
 * punto de venta, `shopify_draft_order` = cotización creada por un vendedor.
 *
 * POR QUÉ IMPORTA LA DISTINCIÓN: "orgánica" NO es lo mismo que "sin asesor
 * asignado". Lo segundo mezcla la venta que entró sola por la web con la del
 * vendedor que olvidó poner su etiqueta — y usarlo como criterio inflaría la
 * meta orgánica a costa de las metas individuales. Este reporte cruza ambos
 * ejes para que se vea el tamaño de esa diferencia antes de fijar metas.
 *
 * Uso: npm run shopify:inspect-order-sources -- --org-slug centr [--months 6]
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { DateTime } from "luxon";
import { withTenantContext } from "@/lib/tenant/context";
import { getTenantScopedClient } from "@/lib/db/client";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { fetchAllPaged } from "@/lib/db/paginate";
import { TIMEZONE } from "@/lib/constants";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function parseArgs(): { orgSlug: string; months: number } {
  const argv = process.argv.slice(2);
  let orgSlug: string | null = null;
  let months = 6;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--months") months = Number(argv[++i] ?? 6);
  }
  if (!orgSlug) {
    console.error("Uso: tsx inspect-order-sources.ts --org-slug <slug> [--months N]");
    process.exit(2);
  }
  return { orgSlug, months };
}

interface OrderRow {
  source: string | null;
  assigned_advisor_id: string | null;
  financial_status: string;
  total_amount: string;
  paid_at: string | null;
}

const money = (n: number) =>
  n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });

async function main() {
  const { orgSlug, months } = parseArgs();
  const org = await getOrganizationBySlug(orgSlug);
  if (!org) {
    console.error(`No existe la organización "${orgSlug}".`);
    process.exit(1);
  }

  const rows = await withTenantContext(org.id, async () => {
    const { supabase, organizationId } = getTenantScopedClient();
    return fetchAllPaged<OrderRow>(() =>
      supabase
        .from("orders")
        .select("source, assigned_advisor_id, financial_status, total_amount, paid_at")
        .eq("organization_id", organizationId),
    );
  }, { source: "script" });

  console.log(`\n=== ORIGEN DE LOS PEDIDOS (org=${orgSlug}) ===`);
  console.log(`Pedidos totales en BD: ${rows.length}\n`);

  // --- Eje 1: distribución por `source` (todos los pedidos) ---
  const bySource = new Map<string, { n: number; paid: number; revenue: number }>();
  for (const r of rows) {
    const key = r.source ?? "(null)";
    const cur = bySource.get(key) ?? { n: 0, paid: 0, revenue: 0 };
    cur.n += 1;
    if (r.financial_status === "paid") {
      cur.paid += 1;
      cur.revenue += Number(r.total_amount) || 0;
    }
    bySource.set(key, cur);
  }

  console.log("--- Por `source` (valor de Shopify) ---");
  const sorted = Array.from(bySource.entries()).sort((a, b) => b[1].n - a[1].n);
  for (const [src, v] of sorted) {
    console.log(
      `  ${src.padEnd(24)} pedidos=${String(v.n).padStart(5)}  pagados=${String(v.paid).padStart(5)}  revenue pagado=${money(v.revenue)}`,
    );
  }

  // --- Eje 2: el cruce que decide la definición ---
  console.log("\n--- Cruce: ¿`source` vs. tener asesor? ---");
  console.log("    (si 'sin asesor' >> 'source web', usar 'sin asesor' como");
  console.log("     criterio de orgánica seria un error: mezcla la venta del");
  console.log("     vendedor que no puso su etiqueta.)\n");
  const cross = new Map<string, { conAsesor: number; sinAsesor: number }>();
  for (const r of rows) {
    const key = r.source ?? "(null)";
    const cur = cross.get(key) ?? { conAsesor: 0, sinAsesor: 0 };
    if (r.assigned_advisor_id) cur.conAsesor += 1;
    else cur.sinAsesor += 1;
    cross.set(key, cur);
  }
  for (const [src, v] of Array.from(cross.entries()).sort(
    (a, b) => b[1].conAsesor + b[1].sinAsesor - (a[1].conAsesor + a[1].sinAsesor),
  )) {
    console.log(`  ${src.padEnd(24)} con asesor=${String(v.conAsesor).padStart(5)}  SIN asesor=${String(v.sinAsesor).padStart(5)}`);
  }

  // --- Eje 3: últimos N meses, que es la escala a la que se ponen metas ---
  const since = DateTime.now().setZone(TIMEZONE).minus({ months }).startOf("month");
  console.log(`\n--- Pedidos PAGADOS por mes y origen (desde ${since.toFormat("yyyy-MM")}) ---`);
  const byMonth = new Map<string, Map<string, { n: number; revenue: number }>>();
  for (const r of rows) {
    if (r.financial_status !== "paid" || !r.paid_at) continue;
    const dt = DateTime.fromISO(r.paid_at, { zone: "utc" }).setZone(TIMEZONE);
    if (dt < since) continue;
    const mk = dt.toFormat("yyyy-MM");
    const inner = byMonth.get(mk) ?? new Map();
    const key = r.source ?? "(null)";
    const cur = inner.get(key) ?? { n: 0, revenue: 0 };
    cur.n += 1;
    cur.revenue += Number(r.total_amount) || 0;
    inner.set(key, cur);
    byMonth.set(mk, inner);
  }
  for (const mk of Array.from(byMonth.keys()).sort()) {
    const inner = byMonth.get(mk)!;
    const total = Array.from(inner.values()).reduce((a, b) => a + b.revenue, 0);
    console.log(`\n  ${mk}   total pagado=${money(total)}`);
    for (const [src, v] of Array.from(inner.entries()).sort((a, b) => b[1].revenue - a[1].revenue)) {
      const pct = total > 0 ? ((v.revenue / total) * 100).toFixed(1) : "0.0";
      console.log(`      ${src.padEnd(24)} ${String(v.n).padStart(4)} pedidos  ${money(v.revenue).padStart(14)}  ${pct.padStart(5)}%`);
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
