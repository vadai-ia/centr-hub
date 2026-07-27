/* eslint-disable no-console */
/**
 * Backfill `orders.is_outbound` desde el CONTACTO (mark permanente, 0040/F4).
 * Snapshot único: un order hereda el canal de su contacto. Idempotente.
 *
 * Uso:
 *   npm run maintenance:backfill-order-is-outbound -- --org-slug centr --dry-run
 *   npm run maintenance:backfill-order-is-outbound -- --org-slug centr
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const argv = process.argv;
  const slug = argv.includes("--org-slug") ? argv[argv.indexOf("--org-slug") + 1] : "centr";
  const dryRun = argv.includes("--dry-run");
  const admin = getSupabaseAdminClient();
  const org = await getOrganizationBySlug(slug);
  if (!org) throw new Error(`org ${slug} no encontrada`);

  // Contactos outbound de la org.
  const { data: obContacts, error: e1 } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", org.id)
    .eq("is_outbound", true);
  if (e1) throw e1;
  const outboundIds = (obContacts ?? []).map((c) => (c as { id: UUID }).id);
  console.log(`Contactos outbound: ${outboundIds.length}`);

  // Órdenes que DEBERÍAN ser outbound pero están en false.
  let toTrue: { id: UUID }[] = [];
  if (outboundIds.length > 0) {
    const { data, error } = await admin
      .from("orders")
      .select("id")
      .eq("organization_id", org.id)
      .eq("is_outbound", false)
      .in("contact_id", outboundIds);
    if (error) throw error;
    toTrue = (data ?? []) as { id: UUID }[];
  }

  // Órdenes marcadas outbound cuyo contacto YA no es outbound (des-marca admin).
  let toFalse: { id: UUID }[] = [];
  {
    let q = admin
      .from("orders")
      .select("id")
      .eq("organization_id", org.id)
      .eq("is_outbound", true);
    if (outboundIds.length > 0) q = q.not("contact_id", "in", `(${outboundIds.join(",")})`);
    const { data, error } = await q;
    if (error) throw error;
    toFalse = (data ?? []) as { id: UUID }[];
  }

  console.log(`Órdenes a poner is_outbound=TRUE:  ${toTrue.length}`);
  console.log(`Órdenes a poner is_outbound=FALSE: ${toFalse.length}`);

  if (dryRun) {
    console.log("\n[DRY-RUN] No se escribió nada.");
    return;
  }

  if (toTrue.length > 0) {
    const { error } = await admin
      .from("orders")
      .update({ is_outbound: true })
      .in("id", toTrue.map((o) => o.id));
    if (error) throw error;
    console.log(`✅ ${toTrue.length} órdenes → is_outbound=true`);
  }
  if (toFalse.length > 0) {
    const { error } = await admin
      .from("orders")
      .update({ is_outbound: false })
      .in("id", toFalse.map((o) => o.id));
    if (error) throw error;
    console.log(`✅ ${toFalse.length} órdenes → is_outbound=false`);
  }
  console.log("\nBackfill completo.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
