/* eslint-disable no-console */
/**
 * Correctivo one-shot — asigna asesor a los contactos NACIDOS EN WHAAPY
 * (last_modified_source='whaapy') con `whaapy_contact_id` y SIN asesor,
 * mapeando su agente de Whaapy → membership (`whaapy_agent_id`). Es el
 * respaldo histórico del fix del inbound (bug 2): los contactos que entraron
 * antes del fix quedaron sin asesor aunque tuvieran agente en Whaapy.
 *
 * Alcance ESTRICTO (decisión del operador): SOLO `last_modified_source='whaapy'`.
 * Los de origen shopify/platform se dejan intactos (no son el caso).
 *
 * Efecto por contacto con agente mapeado:
 *   - contacts.assigned_advisor_id = membership (fill-if-null, R2 no roba).
 *   - rellena el asesor NULL de sus opps activas no-terminales en Funnel Venta
 *     (para que el "Lead nuevo" que quedó sin asesor lo herede).
 * Los que no tienen agente en Whaapy, o el agente no mapea a un vendedor
 * activo, se REPORTAN y se dejan sin tocar.
 *
 * Uso:
 *   npm run maintenance:assign-whaapy-origin-advisors -- --org-slug centr --dry-run
 *   npm run maintenance:assign-whaapy-origin-advisors -- --org-slug centr
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import { whaapyRest } from "@/lib/whaapy/admin-client";
import { WhaapyContactGetResponseSchema } from "@/lib/whaapy/mappers";
import { findActiveMembershipIdByWhaapyAgentId } from "@/lib/db/users";
import { updateContact } from "@/lib/db/contacts";
import { listOpportunities, updateOpportunity } from "@/lib/db/opportunities";
import { recordAuditEvent } from "@/lib/db/operational";
import { isBlockingOpportunity } from "@/lib/services/r12-auto-creation";
import type { Json, UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function parseArgs(): { orgSlug: string; dryRun: boolean } {
  let orgSlug: string | null = null;
  let dryRun = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--dry-run") dryRun = true;
  }
  if (!orgSlug) {
    console.error("Uso: ... --org-slug <slug> [--dry-run]");
    process.exit(2);
  }
  return { orgSlug, dryRun };
}

async function main() {
  const { orgSlug, dryRun } = parseArgs();
  void getSupabaseAdminClient();
  const org = await getOrganizationBySlug(orgSlug);
  if (!org) { console.error(`org ${orgSlug} no encontrada`); process.exit(1); }

  console.log(`Correctivo asesor whaapy-origin en "${org.name}" (dry-run=${dryRun}).\n`);

  await withTenantContext(org.id as UUID, async () => {
    const { supabase, organizationId } = getTenantScopedClient();
    const { data, error } = await supabase
      .from("contacts")
      .select("id, full_name, phone, whaapy_contact_id")
      .eq("organization_id", organizationId)
      .eq("last_modified_source", "whaapy")
      .not("whaapy_contact_id", "is", null)
      .is("assigned_advisor_id", null);
    if (error) throw error;
    const targets = (data ?? []) as Array<{ id: UUID; full_name: string | null; phone: string | null; whaapy_contact_id: string }>;
    console.log(`Candidatos (source=whaapy, sin asesor): ${targets.length}\n`);

    let assigned = 0, unmapped = 0, noAgent = 0;
    for (const c of targets) {
      // GET a Whaapy → agente.
      let agentId: string | null = null;
      try {
        const raw = await whaapyRest<unknown>({ organizationId }, "GET", `/contacts/v1/${c.whaapy_contact_id}`);
        agentId = WhaapyContactGetResponseSchema.parse(raw).contact.assigned_agent_id ?? null;
      } catch (e) {
        console.log(`  [GET-fail] ${c.full_name} [${c.id}]: ${(e as Error).message}`);
        continue;
      }
      if (!agentId) {
        noAgent++;
        console.log(`  [sin-agente] ${c.full_name} [${c.id}] — Whaapy no tiene agente → se deja`);
        continue;
      }
      const membershipId = await findActiveMembershipIdByWhaapyAgentId(organizationId, agentId);
      if (!membershipId) {
        unmapped++;
        console.log(`  [agente-no-mapeado] ${c.full_name} [${c.id}] agent=${agentId} → se deja (mapear en Admin·Agentes)`);
        continue;
      }
      // Opps activas no-terminales sin asesor en Venta.
      const opps = (await listOpportunities({ funnel: "venta", contactId: c.id }))
        .filter((o) => isBlockingOpportunity(o) && o.assigned_advisor_id === null);
      const tag = dryRun ? "[dry-run]" : "[live]";
      console.log(`  ${tag} ${c.full_name} [${c.id}] → asesor=${membershipId} (+${opps.length} opp Venta)`);
      assigned++;
      if (dryRun) continue;

      const ts = new Date().toISOString();
      await updateContact(c.id, { assigned_advisor_id: membershipId, last_modified_at: ts, last_modified_source: "platform" });
      for (const o of opps) {
        await updateOpportunity(o.id, { assigned_advisor_id: membershipId });
      }
      await recordAuditEvent({
        actorUserId: null,
        eventType: "whaapy_origin_advisor_backfilled",
        entityType: "contact",
        entityId: c.id,
        payload: { whaapy_agent_id: agentId, membership_id: membershipId, opportunities_filled: opps.map((o) => o.id) } as Json,
      });
    }

    console.log(`\n=== Reporte ===`);
    console.log(`  asignados${dryRun ? " (simulado)" : ""}: ${assigned}`);
    console.log(`  agente no mapeado (se dejan): ${unmapped}`);
    console.log(`  sin agente en Whaapy (se dejan): ${noAgent}`);
    if (dryRun) console.log(`  (re-correr SIN --dry-run para aplicar)`);
  }, { source: "script" });
}

main().catch((e: Error) => { console.error("correctivo falló:", e.message); process.exit(1); });
