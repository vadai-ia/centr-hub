/* eslint-disable no-console */
/**
 * RANURA DE ATRIBUCIÓN sin login — una "persona" del equipo que NO es una
 * persona: un canal de venta que se etiqueta en Shopify y que la dirección
 * quiere ver medido junto a los vendedores.
 *
 * Caso que lo origina (Centr): la dirección vende con su propia etiqueta y
 * pidió ver cuánto entra por ahí, reflejado en Metas y en el desglose por
 * vendedor, aunque no sea un vendedor de planta ni tenga meta propia.
 *
 * Crea:
 *   1. Membresía con login LATENTE (sin contraseña, mismo patrón que el seed
 *      de Customer Success). NO es usuario sistema: los usuarios sistema
 *      quedan fuera del selector de asesor y de las metas, que es justo lo
 *      contrario de lo que se busca aquí. Rol `vendedor` → el trigger de
 *      0050 le enciende `is_advisor`.
 *   2. Los mapeos de tag → esa membresía (classification `vendor`).
 *
 * Con `--reprocess` corre además la re-atribución RETROACTIVA de cada tag
 * reusando el MISMO servicio que el botón "Re-procesar" de Admin → Mapeo de
 * tags (`runTagReprocessing`): órdenes + su oportunidad ligada + contactos.
 *
 * GUARDA: `reattributeOrders` PISA el asesor actual (no es "solo NULL"), así
 * que este script NO re-procesa una tag si alguna de sus órdenes ya tiene
 * otro asesor — las lista y deja esa decisión como manual.
 *
 * Idempotente: si la membresía ya existe, solo asegura los mapeos.
 *
 * Uso:
 *   npm run maintenance:seed-attribution-slot -- --org-slug centr
 *   npm run maintenance:seed-attribution-slot -- --org-slug centr --apply --reprocess
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import {
  createMembership,
  createUserProfile,
  listManageableMemberships,
} from "@/lib/db/users";
import { getTagMappingByNormalized, upsertTagMapping } from "@/lib/db/configuration";
import { runTagReprocessing } from "@/lib/services/tag-reprocessing";
import { getTenantScopedClient } from "@/lib/db/client";
import { fetchAllPaged } from "@/lib/db/paginate";
import { withTenantContext } from "@/lib/tenant/context";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

const DEFAULT_NAME = "Dirección";
const DEFAULT_TAGS = ["Dirección", "VentaDirección", "Fer"];
const DEFAULT_COLOR = "#F59E0B";

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const normalizeTag = (t: string) => t.trim().toLowerCase();

interface OrderLite {
  id: string;
  shopify_name: string | null;
  financial_status: string;
  subtotal: string;
  assigned_advisor_id: string | null;
  shopify_tags: string[] | null;
}

async function listOrdersLite(): Promise<OrderLite[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  return fetchAllPaged<OrderLite>(() =>
    supabase
      .from("orders")
      .select("id, shopify_name, financial_status, subtotal, assigned_advisor_id, shopify_tags")
      .eq("organization_id", organizationId),
  );
}

async function main() {
  const slug = arg("--org-slug", "centr")!;
  const name = arg("--name", DEFAULT_NAME)!;
  const color = arg("--color", DEFAULT_COLOR)!;
  const tags = (arg("--tags") ?? DEFAULT_TAGS.join(","))
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const email = arg(
    "--email",
    `${normalizeTag(name).replace(/[^a-z0-9]+/g, "")}@${slug}.centrhub.local`,
  )!;
  const apply = process.argv.includes("--apply");
  const reprocess = process.argv.includes("--reprocess");

  const org = await getOrganizationBySlug(slug);
  if (!org) throw new Error(`No existe la organización "${slug}".`);

  console.log(`\n=== RANURA DE ATRIBUCIÓN "${name}" (org=${slug}) ===`);
  console.log(apply ? "MODO: APLICAR (escribe)\n" : "MODO: dry-run (no escribe)\n");

  await withTenantContext(
    org.id as UUID,
    async () => {
      const memberships = await listManageableMemberships(org.id as UUID);
      const found = memberships.find((m) => m.profile.full_name === name);
      let slotId = found?.id as UUID | undefined;

      if (slotId) {
        console.log(`Ya existe la ranura "${name}" (membership ${slotId}).`);
      } else if (!apply) {
        console.log(
          `Crearía la membresía "${name}" (rol vendedor, sin login, ${email}, color ${color}).`,
        );
      } else {
        const admin = getSupabaseAdminClient();
        const created = await admin.auth.admin.createUser({
          email,
          email_confirm: false,
          user_metadata: { full_name: name },
        });
        if (created.error || !created.data?.user) {
          throw new Error(`No se pudo crear el auth user (${email}): ${created.error?.message}`);
        }
        const slotUserId = created.data.user.id as UUID;
        await createUserProfile({
          id: slotUserId,
          full_name: name,
          phone: null,
          avatar_url: null,
          color,
          is_system_user: false,
        });
        const membership = await createMembership({
          user_id: slotUserId,
          organization_id: org.id as UUID,
          role: "vendedor",
          is_active: true,
          whaapy_agent_id: null,
        });
        slotId = membership.id as UUID;
        console.log(`✓ Ranura "${name}" creada (membership ${slotId}, login latente ${email}).`);
      }

      const allOrders = await listOrdersLite();
      console.log("");

      for (const tag of tags) {
        const normalized = normalizeTag(tag);
        const existing = await getTagMappingByNormalized(normalized);
        const hits = allOrders.filter((o) =>
          (o.shopify_tags ?? []).some((t) => normalizeTag(t) === normalized),
        );
        const paid = hits.filter((o) => o.financial_status === "paid");
        const monto = paid.reduce((s, o) => s + Number(o.subtotal), 0);
        const ajenas = hits.filter(
          (o) => o.assigned_advisor_id && o.assigned_advisor_id !== slotId,
        );

        console.log(
          `tag "${tag}" → ${hits.length} pedidos (${paid.length} pagados, ` +
            `$${monto.toLocaleString("es-MX", { maximumFractionDigits: 0 })})`,
        );
        console.log(
          existing
            ? `   hoy: classification=${existing.classification}`
            : "   la tag no existe en el mapeo de la org; se creará",
        );

        if (apply && slotId) {
          await upsertTagMapping({
            normalized_tag: normalized,
            original_tag: existing?.original_tag ?? tag,
            classification: "vendor",
            mapped_membership_id: slotId,
            created_by_user_id: null,
          });
          console.log(`   ✓ mapeada como vendedor → ${name}`);
        }

        if (!reprocess) continue;
        if (ajenas.length > 0) {
          console.log(
            `   ⚠ NO se re-procesa: ${ajenas.length} pedido(s) ya tienen otro asesor ` +
              `(${ajenas.map((o) => o.shopify_name ?? o.id).join(", ")}). ` +
              "El re-proceso PISA al asesor actual — decisión manual.",
          );
          continue;
        }
        if (!apply) {
          console.log(`   re-procesaría ${hits.length} pedidos + sus oportunidades y contactos`);
          continue;
        }
        if (!slotId) continue;
        const affected = await runTagReprocessing({
          normalizedTag: normalized,
          membershipId: slotId,
          actorUserId: null,
        });
        console.log(`   ✓ re-proceso retroactivo: ${affected} entidades re-atribuidas`);
      }

      if (!apply) {
        console.log("\nDry-run: nada escrito. Agrega --apply (y --reprocess) para aplicarlo.");
      }
    },
    { source: "script" },
  );
}

main().catch((e: Error) => {
  console.error("falló:", e.message);
  process.exit(1);
});
