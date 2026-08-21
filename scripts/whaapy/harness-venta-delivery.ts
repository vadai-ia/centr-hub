/* eslint-disable no-console */
/**
 * HARNESS del MENSAJE 1 — confirmación de entrega desde el número de VENTAS.
 *
 * Invoca el MISMO servicio que corre en producción (`pushVentaDeliveryMessage`),
 * así que lo que veas aquí es exactamente lo que pasará cuando una opp entre a
 * "Entregado": escribe el nº de pedido en el contacto de Venta y lo mueve a la
 * etapa "Entregado" de ese funnel. El mensaje lo manda la Automation de Whaapy.
 *
 * ⚠️ MANDA UN WHATSAPP REAL al cliente de la oportunidad que elijas. Para
 * probar sin molestar a nadie, usa una opp cuyo contacto sea tu propio número.
 *
 * Sin `--opportunity-id` NO ejecuta nada: lista candidatas para que elijas.
 *
 * Uso:
 *   npm run whaapy:harness-venta-delivery -- --org-slug centr
 *   npm run whaapy:harness-venta-delivery -- --org-slug centr --opportunity-id <uuid> --dry-run
 *   npm run whaapy:harness-venta-delivery -- --org-slug centr --opportunity-id <uuid>
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { withTenantContext } from "@/lib/tenant/context";
import { resolveVentaStageIdByKey } from "@/lib/whaapy/funnel";
import { pushVentaDeliveryMessage } from "@/lib/whaapy/venta-delivery-push";
import { WHAAPY_VENTA_STAGE_NAMES } from "@/lib/whaapy/config";
import { resolveCustomerFacingOrderRef } from "@/lib/services/order-reference";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DRY_RUN = process.argv.includes("--dry-run");

async function listCandidates(organizationId: UUID) {
  const admin = getSupabaseAdminClient();
  const { data: opps, error } = await admin
    .from("opportunities")
    .select("id, display_reference, shopify_order_id, contact_id, created_at")
    .eq("organization_id", organizationId)
    .eq("funnel", "post_venta")
    .is("cancelled_at", null)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(`opportunities: ${error.message}`);

  const contactIds = (opps ?? []).map((o) => o.contact_id).filter(Boolean) as string[];
  const { data: contacts } = await admin
    .from("contacts")
    .select("id, full_name, phone, whaapy_contact_id")
    .in("id", contactIds);
  const byId = new Map((contacts ?? []).map((c) => [c.id as string, c]));

  console.log(`\nOportunidades de Post-venta más recientes (elige una con --opportunity-id):\n`);
  for (const o of opps ?? []) {
    const c = byId.get(o.contact_id as string);
    const linked = c?.whaapy_contact_id ? "✓ enlazado a Venta" : "✗ SIN whaapy_contact_id";
    console.log(`  ${o.id}`);
    console.log(
      `    ${String(c?.full_name ?? "(sin nombre)").padEnd(28)} ${String(c?.phone ?? "-").padEnd(16)} ${linked}`,
    );
  }
  console.log("");
}

async function main() {
  const slug = arg("--org-slug");
  const opportunityId = arg("--opportunity-id");
  if (!slug) {
    console.error("Uso: --org-slug centr [--opportunity-id <uuid>] [--dry-run]");
    process.exit(1);
  }

  const org = await getOrganizationBySlug(slug);
  if (!org) {
    console.error(`org "${slug}" no encontrada`);
    process.exit(1);
  }

  await withTenantContext(
    org.id as UUID,
    async () => {
      const orgId = org.id as UUID;

      // Pre-vuelo: sin la etapa en el funnel de Venta nada puede funcionar.
      const stageId = await resolveVentaStageIdByKey(orgId, "entregado");
      console.log(`\n=== MENSAJE 1 · confirmación de entrega (VENTA) — ${slug} ===\n`);
      console.log(
        `  etapa "${WHAAPY_VENTA_STAGE_NAMES.entregado}" en el funnel de Venta: ` +
          (stageId ? `✓ ${stageId}` : "✗ NO EXISTE"),
      );
      if (!stageId) {
        console.error(
          `\n✗ Crea la etapa "${WHAAPY_VENTA_STAGE_NAMES.entregado}" en el funnel del Whaapy\n` +
            `  de VENTA (nombre exacto, con mayúscula) y vuelve a correr esto.`,
        );
        process.exit(1);
      }
      console.log(
        `  kill switch VENTA_DELIVERY_MESSAGE_ENABLED: ${process.env.VENTA_DELIVERY_MESSAGE_ENABLED === "true" ? "ON" : "OFF (no afecta a este harness — llama al servicio directo)"}`,
      );

      if (!opportunityId) {
        await listCandidates(orgId);
        return;
      }

      // Qué va a ver el cliente, ANTES de mandarlo.
      const admin = getSupabaseAdminClient();
      const { data: opp } = await admin
        .from("opportunities")
        .select("id, display_reference, shopify_order_id, contact_id")
        .eq("id", opportunityId)
        .maybeSingle();
      if (!opp) {
        console.error(`✗ opp ${opportunityId} no encontrada en ${slug}`);
        process.exit(1);
      }
      const { data: contact } = await admin
        .from("contacts")
        .select("full_name, phone, whaapy_contact_id")
        .eq("id", opp.contact_id as string)
        .maybeSingle();
      const orderRef = await resolveCustomerFacingOrderRef(
        (opp.shopify_order_id as string) ?? null,
      );

      console.log(`\n  contacto      : ${contact?.full_name ?? "(sin nombre)"} · ${contact?.phone ?? "-"}`);
      console.log(`  whaapy (Venta): ${contact?.whaapy_contact_id ?? "✗ SIN ENLAZAR"}`);
      console.log(`  borrador      : ${opp.display_reference ?? "-"}   ← NO va en el mensaje`);
      console.log(`  {{2}} llevará : ${orderRef ?? "(vacío — la opp no tiene pedido enlazado)"}`);

      if (DRY_RUN) {
        console.log(`\n(dry run) Nada enviado. Quitá --dry-run para disparar el mensaje.\n`);
        return;
      }

      const result = await pushVentaDeliveryMessage({
        organizationId: orgId,
        opportunityId: opportunityId as UUID,
      });
      console.log(`\nresultado: ${JSON.stringify(result)}`);
      if ("ok" in result && result.ok && result.moved) {
        console.log(`\n✓ Contacto movido. La Automation de Venta debería estar mandando el mensaje.`);
        console.log(`  Revisa el WhatsApp de ${contact?.phone}.`);
      } else if ("ok" in result && result.ok) {
        console.log(
          `\n⚠  El contacto YA estaba en la etapa: Whaapy no re-dispara (el trigger es\n` +
            `   ENTRAR). Muévelo a otra etapa desde el dashboard y repite.`,
        );
      }
    },
    { source: "script" },
  );
}

main().catch((e: Error) => {
  console.error("falló:", e.message);
  process.exit(1);
});
