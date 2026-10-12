/* eslint-disable no-console */
/**
 * Correctivo — asigna dueño a las oportunidades de **Outbound** que nacieron
 * sin asesor.
 *
 * Las dos vías de creación pasaban `advisorId: null` cableado, así que el
 * tablero del SDR amaneció entero en "Sin asignar" (85 de 90 en Centr). El
 * código ya nace asignando (`resolveOutboundOwner`); esto corrige lo viejo.
 *
 * Garantías:
 *   - **Solo toca lo que está SIN asesor.** Jamás pisa una asignación
 *     existente: el filtro es `assigned_advisor_id IS NULL`, no un UPDATE
 *     masivo. Correrlo dos veces no cambia nada la segunda.
 *   - Solo oportunidades ACTIVAS del funnel `outbound` (no canceladas): una
 *     tarjeta cerrada conserva su historia.
 *   - El dueño tiene que ser un asesor ACTIVO de la organización. Para que un
 *     SDR lo sea, su membresía necesita la ranura `is_advisor` encendida
 *     (Admin → Usuarios) — ver 0050.
 *   - Audit `outbound_opportunity_owner_backfilled` por cada tarjeta.
 *
 * Uso:
 *   # Dry-run (default): dice a quién asignaría y cuántas, sin tocar nada.
 *   npm run maintenance:assign-outbound-owner -- --org-slug centr
 *
 *   # Con un dueño explícito en vez del configurado:
 *   npm run maintenance:assign-outbound-owner -- --org-slug centr --membership-id <id>
 *
 *   # Corrida en vivo:
 *   npm run maintenance:assign-outbound-owner -- --org-slug centr --apply
 *
 * El dueño por defecto se ancla en la organización (una sola vez):
 *   UPDATE organizations
 *   SET config = jsonb_set(config, '{outbound,default_owner_membership_id}',
 *                          to_jsonb('<membership_id>'::text))
 *   WHERE slug = 'centr';
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { listActiveRealVendors } from "@/lib/db/users";
import { recordAuditEvent } from "@/lib/db/operational";
import { readOrganizationOutboundOwner } from "@/lib/services/organization-outbound-owner";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const slug = arg("org-slug");
  const apply = process.argv.includes("--apply");
  const explicito = arg("membership-id");
  if (!slug) {
    console.error("Falta --org-slug");
    process.exit(1);
  }

  const org = await getOrganizationBySlug(slug);
  if (!org) {
    console.error(`No existe la organización "${slug}".`);
    process.exit(1);
  }

  const elegibles = await listActiveRealVendors(org.id);
  const configurado = readOrganizationOutboundOwner(org.config);
  const ownerId = explicito ?? configurado;

  if (!ownerId) {
    console.error(
      "Sin dueño: no hay --membership-id ni `config.outbound.default_owner_membership_id`.\n" +
        "Asesores activos elegibles:",
    );
    for (const v of elegibles) console.error(`  ${v.id}  ${v.profile.full_name}`);
    process.exit(1);
  }

  const owner = elegibles.find((v) => v.id === ownerId);
  if (!owner) {
    console.error(
      `El dueño ${ownerId} no es un asesor ACTIVO de ${slug}.\n` +
        "Si es un SDR, enciéndele la ranura \"Opera oportunidades como asesor\" " +
        "en Admin → Usuarios (0050). Elegibles hoy:",
    );
    for (const v of elegibles) console.error(`  ${v.id}  ${v.profile.full_name}`);
    process.exit(1);
  }

  const sb = getSupabaseAdminClient();
  const { data, error } = await sb
    .from("opportunities")
    .select("id, display_reference, contact_id")
    .eq("organization_id", org.id)
    .eq("funnel", "outbound")
    .is("cancelled_at", null)
    .is("assigned_advisor_id", null);
  if (error) throw error;
  const huerfanas = (data ?? []) as Array<{ id: string; display_reference: string | null }>;

  console.log(
    `${slug}: ${huerfanas.length} oportunidades de Outbound activas SIN asesor.`,
  );
  console.log(`Dueño: ${owner.profile.full_name} (${owner.id})`);
  if (huerfanas.length === 0) return;

  if (!apply) {
    console.log("\n(dry-run — no se tocó nada). Repite con --apply para asignarlas.");
    return;
  }

  let hechas = 0;
  await withTenantContext(
    org.id,
    async () => {
      for (const opp of huerfanas) {
        // Re-filtra por NULL en el propio UPDATE: entre la lectura y la
        // escritura alguien pudo asignarla a mano, y esa asignación manda.
        const { data: upd, error: updErr } = await sb
          .from("opportunities")
          .update({ assigned_advisor_id: owner.id })
          .eq("id", opp.id)
          .eq("organization_id", org.id)
          .is("assigned_advisor_id", null)
          .select("id");
        if (updErr) throw updErr;
        if ((upd ?? []).length === 0) continue;
        hechas += 1;
        try {
          await recordAuditEvent({
            actorUserId: null,
            eventType: "outbound_opportunity_owner_backfilled",
            entityType: "opportunity",
            entityId: opp.id,
            payload: { assigned_advisor_id: owner.id, source: "corrective_backfill" },
          });
        } catch {
          // best-effort: la asignación ya quedó.
        }
      }
    },
    { source: "worker" },
  );

  console.log(`\nListo: ${hechas} oportunidades asignadas a ${owner.profile.full_name}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
