/* eslint-disable no-console */
/**
 * Correctivo — tarjetas de Cotización cuyo CLIENTE en Shopify ya no es el de
 * la tarjeta.
 *
 * El vendedor duplica una cotización y le cambia la persona en Shopify. El
 * webhook `draft_orders/update` sí llega, pero hasta este fix solo actualizaba
 * montos, nota y dirección: la tarjeta se quedaba con el cliente ANTERIOR
 * mientras Shopify mostraba al correcto, y la misma cotización aparecía a
 * nombre de quien ya no era.
 *
 * Pregunta a Shopify el cliente ACTUAL de cada borrador (read-only, en lotes)
 * y re-apunta las que no coinciden, con el MISMO evento de auditoría que el
 * worker en vivo (`DRAFT_CONTACT_REBOUND_EVENT`).
 *
 * Lo que NO toca, y por qué:
 *   - Oportunidades con PEDIDO ligado: ahí manda la orden (su propio worker
 *     ya re-apunta el contacto) y mover la cotización rompería esa cadena.
 *   - Cuando el cliente nuevo todavía no existe en el CRM: crearlo desde este
 *     script lo dejaría a medias (sin teléfono ni identidades). Lo crea el
 *     webhook de `customers/*`; aquí solo se reporta.
 *   - Canceladas y funnels que no son Venta.
 *
 * Uso:
 *   npm run maintenance:rebind-draft-contacts -- --org-slug centr
 *   npm run maintenance:rebind-draft-contacts -- --org-slug centr --apply
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { shopifyGraphql } from "@/lib/shopify/admin-client";
import { getTenantScopedClient } from "@/lib/db/client";
import { fetchAllPaged } from "@/lib/db/paginate";
import { updateOpportunity } from "@/lib/db/opportunities";
import { recordAuditEvent } from "@/lib/db/operational";
import { absorbInitialStageOpportunities } from "@/lib/services/opportunity-absorption";
import { withTenantContext } from "@/lib/tenant/context";
import { DRAFT_CONTACT_REBOUND_EVENT } from "@/lib/constants";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

const CHUNK = 25;

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

interface OppRow {
  id: string;
  contact_id: string;
  stage_id: string;
  shopify_draft_order_id: string | null;
  shopify_order_id: string | null;
  display_reference: string | null;
  actual_amount: string | null;
}

interface ContactRow {
  id: string;
  full_name: string | null;
  shopify_customer_id: string | null;
}

interface DraftNode {
  id: string;
  name?: string | null;
  customer?: { id: string; displayName: string | null } | null;
}

const NODES_QUERY = `query($ids:[ID!]!){
  nodes(ids:$ids){ id ... on DraftOrder { name customer { id displayName } } }
}`;

async function main() {
  const slug = arg("--org-slug", "centr")!;
  const apply = process.argv.includes("--apply");
  const org = await getOrganizationBySlug(slug);
  if (!org) throw new Error(`No existe la organización "${slug}".`);
  const shopOpts = {
    organizationId: org.id as UUID,
    shopDomain: org.shopify_store_domain as string,
  };

  console.log(`\n=== COTIZACIONES CON EL CLIENTE EQUIVOCADO (org=${slug}) ===`);
  console.log(apply ? "MODO: APLICAR (escribe)\n" : "MODO: dry-run (no escribe)\n");

  await withTenantContext(
    org.id as UUID,
    async () => {
      const { supabase, organizationId } = getTenantScopedClient();

      const opps = await fetchAllPaged<OppRow>(() =>
        supabase
          .from("opportunities")
          .select(
            "id, contact_id, stage_id, shopify_draft_order_id, shopify_order_id, display_reference, actual_amount",
          )
          .eq("organization_id", organizationId)
          .eq("funnel", "venta")
          .is("cancelled_at", null)
          .not("shopify_draft_order_id", "is", null),
      );

      const contacts = await fetchAllPaged<ContactRow>(() =>
        supabase
          .from("contacts")
          .select("id, full_name, shopify_customer_id")
          .eq("organization_id", organizationId),
      );
      const byContactId = new Map(contacts.map((c) => [c.id, c]));
      const byShopifyId = new Map(
        contacts.filter((c) => c.shopify_customer_id).map((c) => [c.shopify_customer_id as string, c]),
      );
      const { data: stages } = await supabase
        .from("pipeline_stages")
        .select("id, name")
        .eq("organization_id", organizationId);
      const stageName = new Map((stages ?? []).map((s) => [s.id as string, s.name as string]));

      console.log(`cotizaciones activas con borrador: ${opps.length}`);

      let checked = 0;
      let rebound = 0;
      const skippedNoContact: string[] = [];
      const skippedHasOrder: string[] = [];

      for (let i = 0; i < opps.length; i += CHUNK) {
        const chunk = opps.slice(i, i + CHUNK);
        const ids = chunk.map((o) => `gid://shopify/DraftOrder/${o.shopify_draft_order_id}`);
        const data = await shopifyGraphql<{ nodes: Array<DraftNode | null> }>(shopOpts, NODES_QUERY, {
          ids,
        });

        for (let j = 0; j < chunk.length; j++) {
          const opp = chunk[j];
          const node = data.nodes[j];
          if (!node) continue; // borrador borrado en Shopify
          checked += 1;

          const shopifyCustomerId = node.customer?.id?.split("/").pop() ?? null;
          if (!shopifyCustomerId) continue; // borrador sin cliente

          const current = byContactId.get(opp.contact_id);
          if (current?.shopify_customer_id === shopifyCustomerId) continue; // todo bien

          const label = `${node.name ?? opp.display_reference ?? opp.id} (${stageName.get(opp.stage_id) ?? "?"})`;

          if (opp.shopify_order_id) {
            skippedHasOrder.push(`${label} — ya tiene pedido ligado`);
            continue;
          }
          const target = byShopifyId.get(shopifyCustomerId);
          if (!target) {
            skippedNoContact.push(
              `${label} — el cliente ${node.customer?.displayName ?? shopifyCustomerId} todavía no existe en el CRM`,
            );
            continue;
          }

          console.log(
            `  ${label}  $${opp.actual_amount ?? "-"}\n     tarjeta: ${current?.full_name ?? "?"}  →  real: ${target.full_name ?? "?"}`,
          );
          rebound += 1;
          if (!apply) continue;

          await updateOpportunity(opp.id as UUID, { contact_id: target.id as UUID });
          await recordAuditEvent({
            actorUserId: null,
            eventType: DRAFT_CONTACT_REBOUND_EVENT,
            entityType: "opportunity",
            entityId: opp.id as UUID,
            payload: {
              shopify_draft_order_id: opp.shopify_draft_order_id,
              previous_contact_id: opp.contact_id,
              new_contact_id: target.id,
              shopify_customer_id: shopifyCustomerId,
              source: "corrective_script",
            },
          });
          await absorbInitialStageOpportunities({
            contactId: target.id as UUID,
            absorbingOpportunityId: opp.id as UUID,
            trigger: "draft_order_contact_rebound",
          });
        }
      }

      console.log(`\nverificadas contra Shopify: ${checked}`);
      console.log(apply ? `re-apuntadas: ${rebound}` : `se re-apuntarían: ${rebound}`);
      if (skippedHasOrder.length > 0) {
        console.log(`\nNO se tocan (ya tienen pedido): ${skippedHasOrder.length}`);
        for (const s of skippedHasOrder) console.log(`  ${s}`);
      }
      if (skippedNoContact.length > 0) {
        console.log(`\nNO se tocan (cliente aún no está en el CRM): ${skippedNoContact.length}`);
        for (const s of skippedNoContact) console.log(`  ${s}`);
      }
      if (!apply) console.log("\nDry-run: nada escrito. Agrega --apply para aplicarlo.");
    },
    { source: "script" },
  );
}

main().catch((e: Error) => {
  console.error("falló:", e.message);
  process.exit(1);
});
