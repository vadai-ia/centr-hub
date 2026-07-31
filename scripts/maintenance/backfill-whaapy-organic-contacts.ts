/* eslint-disable no-console */
/**
 * Correctivo one-shot — recupera los leads ORGÁNICOS de Whaapy (source=webhook)
 * que no llegaron a la plataforma porque `conversation.created` moría en DLQ
 * por el schema roto (ver ERRORES.md "conversation.* usa conversation_id").
 * Los CREA en la plataforma (identity-match + agente→asesor) y dispara R12
 * ("Lead nuevo" con el vendedor asignado). Reusa el MISMO camino que el worker.
 *
 * Alcance ESTRICTO (decisión del operador): SOLO `source=webhook` (orgánicos).
 * Deja intactos los `source=import` (6.9k del import histórico — entrarán solos
 * cuando escriban) y los `source=api`.
 *
 * Uso:
 *   npm run maintenance:backfill-whaapy-organic -- --org-slug centr --dry-run
 *   npm run maintenance:backfill-whaapy-organic -- --org-slug centr
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import { whaapyRest } from "@/lib/whaapy/admin-client";
import { WhaapyContactGetResponseSchema } from "@/lib/whaapy/mappers";
import { ingestWhaapyContact } from "@/lib/services/whaapy-contact-ingest";
import { findActiveMembershipIdByWhaapyAgentId } from "@/lib/db/users";
import { evaluateAndCreateC2Opportunity } from "@/lib/services/r12-auto-creation";
import { recordAuditEvent } from "@/lib/db/operational";
import type { Json, UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function parseArgs(): { orgSlug: string; dryRun: boolean; expectedMax: number } {
  let orgSlug: string | null = null;
  let dryRun = false;
  let expectedMax = 50; // tope defensivo: los orgánicos esperados son ~pocos
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--expected-max") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) expectedMax = n;
    }
  }
  if (!orgSlug) { console.error("Uso: ... --org-slug <slug> [--dry-run] [--expected-max N]"); process.exit(2); }
  return { orgSlug, dryRun, expectedMax };
}

function digits(s: string | null | undefined): string { return (s ?? "").replace(/\D/g, ""); }

async function main() {
  const { orgSlug, dryRun, expectedMax } = parseArgs();
  void getSupabaseAdminClient();
  const org = await getOrganizationBySlug(orgSlug);
  if (!org) { console.error(`org ${orgSlug} no encontrada`); process.exit(1); }

  console.log(`Backfill orgánicos Whaapy en "${org.name}" (dry-run=${dryRun}).\n`);

  await withTenantContext(org.id as UUID, async () => {
    const { supabase, organizationId } = getTenantScopedClient();

    // Sets de la plataforma (whaapy_contact_id + últimos 10 dígitos del teléfono).
    const { data: plat } = await supabase.from("contacts")
      .select("whaapy_contact_id, phone").eq("organization_id", organizationId).limit(20000);
    const platWids = new Set<string>();
    const platPhones = new Set<string>();
    for (const c of (plat as any[] ?? [])) {
      if (c.whaapy_contact_id) platWids.add(c.whaapy_contact_id);
      const d10 = digits(c.phone).slice(-10);
      if (d10.length === 10) platPhones.add(d10);
    }

    // Paginar TODOS los contactos de Whaapy, filtrar source=webhook faltantes.
    const targets: Array<{ id: string; phone: string; name: string; agent: string | null }> = [];
    let cursor: string | null = null; let pages = 0;
    do {
      const path: string = cursor ? `/contacts/v1?limit=100&cursor=${encodeURIComponent(cursor)}` : `/contacts/v1?limit=100`;
      const resp: any = await whaapyRest<unknown>({ organizationId }, "GET", path);
      for (const c of (resp?.contacts ?? [])) {
        if (c.source !== "webhook") continue;
        const d10 = digits(c.phone_number).slice(-10);
        const inPlat = platWids.has(c.id) || (d10.length === 10 && platPhones.has(d10));
        if (!inPlat) targets.push({ id: c.id, phone: c.phone_number ?? "", name: c.name ?? "", agent: c.assigned_agent_id ?? null });
      }
      cursor = resp?.pagination?.has_more ? resp?.pagination?.next_cursor ?? null : null;
      pages++;
    } while (cursor && pages < 200);

    console.log(`Orgánicos (source=webhook) sin contraparte: ${targets.length}\n`);
    if (targets.length === 0) { console.log("Nada que recuperar."); return; }
    if (targets.length > expectedMax) {
      console.error(`ABORTADO: ${targets.length} candidatos > tope ${expectedMax}. Re-correr con --expected-max ${targets.length} si es esperado.`);
      for (const t of targets) console.log(`  ${t.phone} ${t.name} agent=${t.agent ?? "no"} id=${t.id}`);
      process.exit(3);
    }

    let created = 0, oppCreated = 0, linked = 0, unmappedAgent = 0;
    for (const t of targets) {
      // GET snapshot completo (agente/email/address).
      const snap = WhaapyContactGetResponseSchema.parse(
        await whaapyRest<unknown>({ organizationId }, "GET", `/contacts/v1/${t.id}`),
      ).contact;
      const agentAdvisor = snap.assigned_agent_id
        ? await findActiveMembershipIdByWhaapyAgentId(organizationId, snap.assigned_agent_id)
        : null;
      if (snap.assigned_agent_id && !agentAdvisor) unmappedAgent++;
      const tag = dryRun ? "[dry-run]" : "[live]";
      console.log(`  ${tag} ${t.phone} "${t.name}" agent=${snap.assigned_agent_id ?? "no"} → asesor=${agentAdvisor ?? "sin mapeo/null"}`);
      if (dryRun) continue;

      const ts = new Date().toISOString();
      const ingested = await ingestWhaapyContact({
        whaapyContactId: t.id,
        phone: snap.phone_number ?? t.phone ?? null,
        name: snap.name ?? t.name ?? null,
        email: snap.email ?? null,
        address: (snap.address ?? null) as Json | null,
        assignedAgentId: snap.assigned_agent_id ?? null,
        effectiveUpdatedAt: snap.updated_at ?? ts,
        receivedAt: ts,
      });
      if (ingested.created) created++; else linked++;
      const r12 = await evaluateAndCreateC2Opportunity({
        contact: ingested.contact,
        trigger: "new_contact_in_whaapy",
        triggeredByEvent: "conversation.created",
        previousActivityAt: null,
        currentActivityAt: ts,
      });
      if (r12.created) oppCreated++;
      await recordAuditEvent({
        actorUserId: null,
        eventType: "whaapy_organic_contact_backfilled",
        entityType: "contact",
        entityId: ingested.contact.id,
        payload: { whaapy_contact_id: t.id, advisor: ingested.advisorFromAgent, opportunity_created: r12.created } as Json,
      });
    }

    console.log(`\n=== Reporte ===`);
    console.log(`  candidatos: ${targets.length}`);
    if (dryRun) { console.log(`  (re-correr SIN --dry-run para aplicar)`); return; }
    console.log(`  contactos creados: ${created} · enlazados a existente: ${linked}`);
    console.log(`  oportunidades "Lead nuevo" creadas: ${oppCreated}`);
    console.log(`  agente sin mapeo (contacto quedó sin asesor): ${unmappedAgent}`);
  }, { source: "script" });
}

main().catch((e: Error) => { console.error("backfill falló:", e.message); process.exit(1); });
