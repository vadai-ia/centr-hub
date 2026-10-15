/* eslint-disable no-console */
/**
 * Correctivo — asigna un asesor a las oportunidades ACTIVAS que quedaron sin
 * dueño en un funnel.
 *
 * Hermano de `assign-outbound-owner`, que cubre solo Outbound y toma el dueño
 * del ancla de la organización. Aquí el asesor se pasa SIEMPRE explícito: no
 * hay un "dueño por defecto" de Venta, y repartir cartera comercial es una
 * decisión de quien dirige, no un default que un script pueda inventar.
 *
 * Garantías:
 *   - **Solo toca lo que está SIN asesor** (`assigned_advisor_id IS NULL`,
 *     re-filtrado en el propio UPDATE por si alguien asignó a mano entre la
 *     lectura y la escritura). Jamás pisa una asignación existente, así que
 *     correrlo dos veces no cambia nada la segunda.
 *   - **No toca canceladas ni cerradas.** Una oportunidad en etapa ganada
 *     sin asesor es venta sin atribuir: asignarla le acreditaría a esa
 *     persona una venta que quizá no hizo, y una perdida le colgaría una
 *     derrota ajena. Las dos contaminan su tasa de cierre. Se reportan
 *     aparte para decidirlas a mano.
 *   - El asesor tiene que ser ACTIVO y con la ranura `is_advisor` encendida
 *     (0050) — es la misma regla que usa el selector de asesor.
 *   - Audit `opportunity_advisor_backfilled` por cada tarjeta, con el funnel
 *     y la etapa en que estaba.
 *
 * Uso:
 *   # Dry-run (default): dice cuántas y en qué etapas, sin tocar nada.
 *   npm run maintenance:assign-unassigned-opps -- --org-slug centr-colombia --membership-id <id>
 *
 *   # Con otro funnel:
 *   npm run maintenance:assign-unassigned-opps -- --org-slug centr --membership-id <id> --funnel postventa
 *
 *   # Corrida en vivo:
 *   npm run maintenance:assign-unassigned-opps -- --org-slug centr-colombia --membership-id <id> --apply
 *
 * Sin `--membership-id` imprime los asesores elegibles y sale.
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { listActiveRealVendors } from "@/lib/db/users";
import { recordAuditEvent } from "@/lib/db/operational";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

interface StageRow {
  id: string;
  name: string;
  is_won: boolean;
  is_lost: boolean;
}

async function main() {
  const slug = arg("org-slug");
  const membershipId = arg("membership-id");
  const funnel = arg("funnel") ?? "venta";
  const apply = process.argv.includes("--apply");
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
  if (!membershipId) {
    console.error(`Falta --membership-id. Asesores activos de ${slug}:`);
    for (const v of elegibles) console.error(`  ${v.id}  ${v.profile.full_name}`);
    process.exit(1);
  }
  const asesor = elegibles.find((v) => v.id === membershipId);
  if (!asesor) {
    console.error(
      `${membershipId} no es un asesor ACTIVO de ${slug}.\n` +
        'Si es un SDR o un admin que opera cartera, enciéndele la ranura "Opera\n' +
        'oportunidades como asesor" en Admin → Usuarios (0050). Elegibles hoy:',
    );
    for (const v of elegibles) console.error(`  ${v.id}  ${v.profile.full_name}`);
    process.exit(1);
  }

  const sb = getSupabaseAdminClient();
  const { data: stageRows, error: stageErr } = await sb
    .from("pipeline_stages")
    .select("id, name, is_won, is_lost")
    .eq("organization_id", org.id)
    .eq("funnel", funnel);
  if (stageErr) throw stageErr;
  const stages = new Map(
    ((stageRows ?? []) as StageRow[]).map((s) => [s.id, s]),
  );

  const { data, error } = await sb
    .from("opportunities")
    .select("id, stage_id")
    .eq("organization_id", org.id)
    .eq("funnel", funnel)
    .is("cancelled_at", null)
    .is("assigned_advisor_id", null);
  if (error) throw error;

  const candidatas: Array<{ id: string; etapa: string }> = [];
  const terminales: Array<{ id: string; etapa: string }> = [];
  for (const o of (data ?? []) as Array<{ id: string; stage_id: string }>) {
    const s = stages.get(o.stage_id);
    const etapa = s?.name ?? "(etapa desconocida)";
    if (s?.is_won || s?.is_lost) terminales.push({ id: o.id, etapa });
    else candidatas.push({ id: o.id, etapa });
  }

  const porEtapa = new Map<string, number>();
  for (const c of candidatas) porEtapa.set(c.etapa, (porEtapa.get(c.etapa) ?? 0) + 1);

  console.log(`${slug} · funnel "${funnel}"`);
  console.log(`Asesor: ${asesor.profile.full_name} (${asesor.id})\n`);
  console.log(`Oportunidades activas SIN asesor: ${candidatas.length}`);
  for (const [k, v] of Array.from(porEtapa.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(32)} ${v}`);
  }
  if (terminales.length > 0) {
    console.log(
      `\nNO se tocan ${terminales.length} en etapa ganada/perdida: asignarlas\n` +
        `acreditaría a esa persona una venta o una pérdida que quizá no es suya.\n` +
        `Decidirlas a mano desde el detalle de cada oportunidad.`,
    );
  }
  if (candidatas.length === 0) return;

  if (!apply) {
    console.log("\n(dry-run — no se tocó nada). Repite con --apply para asignarlas.");
    return;
  }

  let hechas = 0;
  await withTenantContext(
    org.id,
    async () => {
      for (const opp of candidatas) {
        // Re-filtra por NULL en el propio UPDATE: entre la lectura y la
        // escritura alguien pudo asignarla a mano, y esa asignación manda.
        const { data: upd, error: updErr } = await sb
          .from("opportunities")
          .update({ assigned_advisor_id: asesor.id })
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
            eventType: "opportunity_advisor_backfilled",
            entityType: "opportunity",
            entityId: opp.id,
            payload: {
              assigned_advisor_id: asesor.id,
              funnel,
              stage_name: opp.etapa,
              source: "corrective_backfill",
            },
          });
        } catch {
          // best-effort: la asignación ya quedó.
        }
      }
    },
    { source: "worker" },
  );

  console.log(`\nListo: ${hechas} asignadas a ${asesor.profile.full_name}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
