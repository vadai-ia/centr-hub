/* eslint-disable no-console */
/**
 * Crea la oportunidad de Post-venta que le falta a cada COMPRA ONLINE ya
 * ingresada (`orders.source = 'web'`, pagada, sin `opportunity_id`).
 *
 * Por qué hace falta: la cadena de oportunidades cuelga del Draft Order, y una
 * compra online no tiene ninguno — así que el trigger F1→F2 nunca creó la
 * hija. Medido en Centr antes de este correctivo: 294 de 294 pedidos online
 * sin ninguna oportunidad, invisibles para Post-venta.
 *
 * Reusa `ensureOnlineOrderOpportunity`, el MISMO servicio que corre en vivo
 * desde los webhooks, así que el histórico y lo nuevo no pueden divergir en
 * qué crean ni dónde lo colocan.
 *
 * NO mueve etapas: todo nace en "Pago confirmado" y el motor de Post-venta lo
 * reacomoda en su siguiente pasada según el estado de entrega de cada pedido.
 *
 * Idempotente: una segunda corrida no crea nada (el pedido ya quedó enlazado).
 *
 * Uso:
 *   npm run maintenance:backfill-online-orders -- --org-slug centr --dry-run
 *   npm run maintenance:backfill-online-orders -- --org-slug centr
 *   npm run maintenance:backfill-online-orders -- --org-slug centr --limit 25
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { withTenantContext } from "@/lib/tenant/context";
import { ensureOnlineOrderOpportunity } from "@/lib/services/online-order-opportunity";
import { ONLINE_ORDER_SOURCE } from "@/lib/constants";
import type { OrderRow, UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const slug = arg("--org-slug");
  if (!slug) {
    console.error("Uso: --org-slug centr [--limit N] [--dry-run]");
    process.exit(1);
  }
  const limit = Number(arg("--limit") ?? "1000");

  const org = await getOrganizationBySlug(slug);
  if (!org) {
    console.error(`org "${slug}" no encontrada`);
    process.exit(1);
  }

  await withTenantContext(
    org.id as UUID,
    async () => {
      const admin = getSupabaseAdminClient();
      const { data, error } = await admin
        .from("orders")
        .select("*")
        .eq("organization_id", org.id)
        .eq("source", ONLINE_ORDER_SOURCE)
        .eq("financial_status", "paid")
        .is("opportunity_id", null)
        .order("shopify_created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`orders: ${error.message}`);
      const pendientes = (data ?? []) as unknown as OrderRow[];

      console.log(
        `\n=== Compras online sin oportunidad — ${slug} ${DRY_RUN ? "(DRY RUN)" : ""}===\n`,
      );
      console.log(`  pedidos a procesar: ${pendientes.length}`);
      if (pendientes.length === 0) {
        console.log(`\n  Nada que hacer.\n`);
        return;
      }

      const monto = pendientes.reduce((s, o) => s + Number(o.total_amount ?? 0), 0);
      console.log(`  monto total       : $${Math.round(monto).toLocaleString("es-MX")}`);
      console.log(`  más antiguo       : ${pendientes.at(-1)?.shopify_created_at}`);
      console.log(`  más reciente      : ${pendientes[0]?.shopify_created_at}`);
      console.log(`\n  Muestra:`);
      for (const o of pendientes.slice(0, 8)) {
        console.log(
          `    ${String(o.shopify_name).padEnd(9)} $${String(o.total_amount).padStart(11)}  ${o.shopify_created_at}`,
        );
      }

      if (DRY_RUN) {
        console.log(
          `\n(dry run) Se crearían ${pendientes.length} oportunidades en "Pago confirmado",\n` +
            `sin asesor. El motor las reacomodará según su estado de entrega.\n` +
            `Quitá --dry-run para aplicar.\n`,
        );
        return;
      }

      let creadas = 0;
      const omitidas = new Map<string, number>();
      for (const o of pendientes) {
        try {
          const r = await ensureOnlineOrderOpportunity(o);
          if (r.created) creadas += 1;
          else omitidas.set(r.reason, (omitidas.get(r.reason) ?? 0) + 1);
        } catch (err) {
          // Un pedido roto no debe abortar el resto del correctivo.
          console.error(`  ✗ ${o.shopify_name}: ${(err as Error).message}`);
          omitidas.set("error", (omitidas.get("error") ?? 0) + 1);
        }
      }

      console.log(`\n✓ oportunidades creadas: ${creadas}`);
      if (omitidas.size > 0) {
        console.log(`  omitidas: ${JSON.stringify(Object.fromEntries(omitidas))}`);
      }
      console.log(
        `\nEl motor de Post-venta las reacomodará en su próxima corrida horaria\n` +
          `(o antes, si llega un webhook de esos pedidos).\n`,
      );
    },
    { source: "script" },
  );
}

main().catch((e: Error) => {
  console.error("falló:", e.message);
  process.exit(1);
});
