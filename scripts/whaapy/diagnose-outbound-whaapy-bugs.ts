/* eslint-disable no-console */
/**
 * DIAGNÓSTICO READ-ONLY — tres bugs Outbound → Whaapy. NO escribe nada.
 *
 * 1) Duplicado "Lead nuevo" tras handoff: para el/los contacto(s) de prueba
 *    lista TODAS sus opps (funnel/etapa/is_initial/asesor/cancelled) + el
 *    rastro de audit (c2_opportunity_auto_created, c2_evaluation_skipped,
 *    sync_loop_prevented, lead_created, whaapy_contact_*_outbound, handoff*).
 * 2) Alcance del "sin asesor": cuenta contactos con whaapy_contact_id != null
 *    y assigned_advisor_id = null, y cuántos de ellos tienen un "Lead nuevo"
 *    (Venta, is_initial) activo sin asesor.
 * 3) Mapeo whaapy_agent_id por vendedor (para saber si el inbound PODRÍA
 *    mapear agente → asesor).
 *
 * Uso: tsx --tsconfig scripts/tsconfig.json scripts/whaapy/diagnose-outbound-whaapy-bugs.ts --org-slug centr [--name "Outbound prueba 4"]
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function parseArgs(): { orgSlug: string; name: string } {
  let orgSlug: string | null = null;
  let name = "Outbound prueba";
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--name") name = argv[++i] ?? name;
  }
  if (!orgSlug) {
    console.error("Uso: ... --org-slug <slug> [--name <contact name>]");
    process.exit(2);
  }
  return { orgSlug, name };
}

async function main() {
  const { orgSlug, name } = parseArgs();
  void getSupabaseAdminClient();
  const org = await getOrganizationBySlug(orgSlug);
  if (!org) {
    console.error(`org ${orgSlug} no encontrada`);
    process.exit(1);
  }

  await withTenantContext(
    org.id as UUID,
    async () => {
      const { supabase, organizationId } = getTenantScopedClient();

      // Etapas Venta (para is_initial + nombre).
      const { data: stagesV } = await supabase
        .from("pipeline_stages")
        .select("id, name, funnel, is_initial, position")
        .eq("organization_id", organizationId);
      const stageById = new Map<string, { name: string; funnel: string; is_initial: boolean; position: number }>();
      for (const s of (stagesV ?? []) as Array<{ id: string; name: string; funnel: string; is_initial: boolean; position: number }>) {
        stageById.set(s.id, { name: s.name, funnel: s.funnel, is_initial: s.is_initial, position: s.position });
      }

      // ---------- BUG 1: contacto(s) de prueba ----------
      console.log(`\n=== BUG 1 — contacto(s) ilike "%${name}%" ===`);
      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, full_name, phone, whaapy_contact_id, assigned_advisor_id, is_outbound, created_at, last_modified_at, last_modified_source, deleted_in_whaapy")
        .eq("organization_id", organizationId)
        .ilike("full_name", `%${name}%`)
        .order("created_at", { ascending: false });
      const cs = (contacts ?? []) as Array<Record<string, unknown>>;
      if (cs.length === 0) console.log("  (ninguno)");
      for (const c of cs) {
        console.log(`\n  contact ${c.id} — "${c.full_name}" phone=${c.phone}`);
        console.log(`    whaapy_contact_id=${c.whaapy_contact_id ?? "NULL"} assigned_advisor_id=${c.assigned_advisor_id ?? "NULL"} is_outbound=${c.is_outbound} last_modified_source=${c.last_modified_source} last_modified_at=${c.last_modified_at}`);

        const { data: opps } = await supabase
          .from("opportunities")
          .select("id, funnel, stage_id, assigned_advisor_id, is_outbound, cancelled_at, cancellation_source, won_at, lost_at, created_at, effective_created_at, last_modified_source")
          .eq("organization_id", organizationId)
          .eq("contact_id", c.id as string)
          .order("created_at", { ascending: true });
        for (const o of (opps ?? []) as Array<Record<string, unknown>>) {
          const st = stageById.get(o.stage_id as string);
          console.log(
            `    opp ${o.id} funnel=${o.funnel} stage="${st?.name}"(init=${st?.is_initial},pos=${st?.position}) ` +
              `advisor=${o.assigned_advisor_id ?? "NULL"} is_outbound=${o.is_outbound} cancelled=${o.cancelled_at ?? "no"} ` +
              `won=${o.won_at ?? "no"} created=${o.created_at} src=${o.last_modified_source}`,
          );
        }

        const { data: audits } = await supabase
          .from("audit_log")
          .select("event_type, created_at, payload, entity_type, entity_id")
          .eq("organization_id", organizationId)
          .eq("entity_id", c.id as string)
          .order("created_at", { ascending: true });
        // También audits de las opps del contacto.
        const oppIds = ((opps ?? []) as Array<{ id: string }>).map((o) => o.id);
        const { data: oppAudits } = oppIds.length
          ? await supabase
              .from("audit_log")
              .select("event_type, created_at, payload, entity_type, entity_id")
              .eq("organization_id", organizationId)
              .in("entity_id", oppIds)
              .order("created_at", { ascending: true })
          : { data: [] };
        const all = [...((audits ?? []) as Array<Record<string, unknown>>), ...((oppAudits ?? []) as Array<Record<string, unknown>>)]
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        console.log(`    --- audit trail (${all.length}) ---`);
        for (const a of all) {
          console.log(`      ${a.created_at} ${a.event_type} [${a.entity_type}] ${JSON.stringify(a.payload)}`);
        }
      }

      // ---------- BUG 2: alcance sin-asesor ----------
      console.log(`\n=== BUG 2 — alcance "inbound Whaapy sin asesor" ===`);
      const { count: totalContacts } = await supabase
        .from("contacts").select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId);
      const { count: whaapyLinked } = await supabase
        .from("contacts").select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId).not("whaapy_contact_id", "is", null);
      const { count: whaapyLinkedNoAdvisor } = await supabase
        .from("contacts").select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .not("whaapy_contact_id", "is", null)
        .is("assigned_advisor_id", null);
      console.log(`  total contactos:                              ${totalContacts}`);
      console.log(`  con whaapy_contact_id:                        ${whaapyLinked}`);
      console.log(`  con whaapy_contact_id y SIN asesor (proxy):   ${whaapyLinkedNoAdvisor}`);

      // Cuántos "Lead nuevo" (Venta, is_initial) activos SIN asesor.
      const initialVentaIds = ((stagesV ?? []) as Array<{ id: string; funnel: string; is_initial: boolean }>)
        .filter((s) => s.funnel === "venta" && s.is_initial).map((s) => s.id);
      let leadNuevoNoAdvisor = 0;
      if (initialVentaIds.length) {
        const { count } = await supabase
          .from("opportunities").select("id", { count: "exact", head: true })
          .eq("organization_id", organizationId)
          .eq("funnel", "venta")
          .in("stage_id", initialVentaIds)
          .is("assigned_advisor_id", null)
          .is("cancelled_at", null)
          .is("won_at", null)
          .is("lost_at", null);
        leadNuevoNoAdvisor = count ?? 0;
      }
      console.log(`  "Lead nuevo" (Venta, inicial) activos SIN asesor: ${leadNuevoNoAdvisor}`);

      // ---------- BUG 2b: mapeo whaapy_agent_id por vendedor ----------
      console.log(`\n=== whaapy_agent_id por membership (vendedores) ===`);
      const { data: mems } = await supabase
        .from("memberships")
        .select("id, role, is_active, whaapy_agent_id, user_id")
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: true });
      for (const m of (mems ?? []) as Array<Record<string, unknown>>) {
        console.log(`  membership ${m.id} role=${m.role} active=${m.is_active} whaapy_agent_id=${m.whaapy_agent_id ?? "NULL"}`);
      }
    },
    { source: "script" },
  );
}

main().catch((err: Error) => {
  console.error("diagnose falló:", err.message);
  process.exit(1);
});
