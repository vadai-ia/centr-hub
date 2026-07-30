/* eslint-disable no-console */
/**
 * READ-ONLY — diagnóstico del gap "contactos nacidos en Whaapy no llegan a la
 * plataforma" + "cambio de agente en Whaapy no sincroniza". NO escribe nada.
 *
 * 1) Localiza un contacto por teléfono en Whaapy (by-phone) → id/agente/source/
 *    conversación, y confirma si existe en la plataforma.
 * 2) whaapy_raw_webhooks: eventos que lo mencionan + distribución reciente por
 *    evento + `source` de los bodies contact.created (¿alguna vez llega un
 *    contact.created ORGÁNICO, o solo ecos de nuestros POST source=api?).
 * 3) Gap: lista TODOS los contactos de Whaapy (paginado) y cuenta cuántos NO
 *    tienen contraparte en la plataforma (por whaapy_contact_id o teléfono),
 *    desglosado por `source`.
 *
 * Uso: tsx --tsconfig scripts/tsconfig.json scripts/whaapy/diagnose-inbound-gap.ts --org-slug centr --phone 525525632336
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import { whaapyRest } from "@/lib/whaapy/admin-client";
import { normalizePhone } from "@/lib/services/identity-matching";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function parseArgs(): { orgSlug: string; phone: string } {
  let orgSlug = "centr";
  let phone = "525525632336";
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org-slug") orgSlug = argv[++i] ?? orgSlug;
    else if (argv[i] === "--phone") phone = argv[++i] ?? phone;
  }
  return { orgSlug, phone };
}

function digits(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

async function main() {
  const { orgSlug, phone } = parseArgs();
  void getSupabaseAdminClient();
  const org = await getOrganizationBySlug(orgSlug);
  if (!org) { console.error(`org ${orgSlug} no encontrada`); process.exit(1); }

  await withTenantContext(org.id as UUID, async () => {
    const { supabase, organizationId } = getTenantScopedClient();

    // ---------- 1) MHFP por teléfono ----------
    console.log(`=== 1) Whaapy by-phone ${phone} ===`);
    let whaapyContactId: string | null = null;
    try {
      const conv = await whaapyRest<any>({ organizationId }, "GET", `/conversations/v1/by-phone/${phone}`);
      const d = conv?.data ?? conv;
      whaapyContactId = d?.contact?.id ?? d?.contactId ?? null;
      console.log(`  conversation id=${d?.id} status=${d?.status} lastMessageAt=${d?.lastMessageAt}`);
      console.log(`  assignedTo=${JSON.stringify(d?.assignedTo ?? null)}`);
      console.log(`  contact.id=${whaapyContactId} name=${d?.contact?.name ?? d?.contactName}`);
    } catch (e) {
      console.log(`  by-phone falló: ${(e as Error).message}`);
    }
    // GET del contacto para source + agente
    if (whaapyContactId) {
      try {
        const c = await whaapyRest<any>({ organizationId }, "GET", `/contacts/v1/${whaapyContactId}`);
        const inner = c?.contact ?? c?.data ?? c;
        console.log(`  contact source=${inner?.source} assigned_agent_id=${inner?.assigned_agent_id} created_at=${inner?.created_at}`);
      } catch (e) { console.log(`  GET contact falló: ${(e as Error).message}`); }
    }

    // ¿existe en la plataforma? por whaapy_contact_id o por teléfono
    console.log(`\n=== plataforma: ¿existe MHFP? ===`);
    const pDigits = digits(normalizePhone(phone, "MX") ?? phone);
    const { data: byWid } = whaapyContactId
      ? await supabase.from("contacts").select("id, full_name, phone, assigned_advisor_id").eq("organization_id", organizationId).eq("whaapy_contact_id", whaapyContactId)
      : { data: [] };
    console.log(`  por whaapy_contact_id: ${(byWid as any[])?.length ?? 0}`);
    // por teléfono (trae candidatos y compara dígitos)
    const { data: allPhones } = await supabase.from("contacts").select("id, full_name, phone, whaapy_contact_id").eq("organization_id", organizationId).not("phone", "is", null).limit(5000);
    const phoneHit = (allPhones as any[] ?? []).filter(c => digits(c.phone).endsWith(pDigits.slice(-10)));
    console.log(`  por teléfono (últimos 10 dígitos): ${phoneHit.length}`);
    for (const h of phoneHit.slice(0,3)) console.log(`    ${h.id} ${h.full_name} ${h.phone} wid=${h.whaapy_contact_id}`);

    // ---------- 2) raw webhooks ----------
    console.log(`\n=== 2) whaapy_raw_webhooks ===`);
    const { data: raws } = await supabase.from("whaapy_raw_webhooks").select("received_at, endpoint, exit_reason, body").order("received_at", { ascending: false }).limit(500);
    const rows = (raws as any[] ?? []);
    // eventos que mencionan MHFP
    const mine = rows.filter(r => {
      const s = JSON.stringify(r.body ?? "");
      return (whaapyContactId && s.includes(whaapyContactId)) || s.includes(phone) || digits(s).includes(pDigits.slice(-10));
    });
    console.log(`  filas que mencionan MHFP: ${mine.length}`);
    for (const r of mine.reverse()) console.log(`    ${r.received_at} ${r.body?.event} exit=${r.exit_reason}`);
    // distribución por evento (últimas 500)
    console.log(`  --- distribución por evento (últimas ${rows.length}) ---`);
    const byEvent = new Map<string, number>();
    for (const r of rows) { const e = r.body?.event ?? "?"; byEvent.set(e, (byEvent.get(e) ?? 0) + 1); }
    for (const [k, v] of Array.from(byEvent.entries()).sort()) console.log(`    ${k}: ${v}`);
    // source de los contact.created
    console.log(`  --- source de los contact.created ---`);
    const created = rows.filter(r => r.body?.event === "contact.created");
    const bySource = new Map<string, number>();
    for (const r of created) { const s = r.body?.data?.source ?? "(sin source)"; bySource.set(s, (bySource.get(s) ?? 0) + 1); }
    for (const [k, v] of Array.from(bySource.entries()).sort()) console.log(`    source=${k}: ${v}`);
    const lastCreated = created[0];
    if (lastCreated) console.log(`    último contact.created: ${lastCreated.received_at} source=${lastCreated.body?.data?.source}`);

    // ---------- 3) gap size ----------
    console.log(`\n=== 3) GAP: contactos Whaapy sin contraparte en plataforma ===`);
    // set de la plataforma
    const { data: platContacts } = await supabase.from("contacts").select("whaapy_contact_id, phone").eq("organization_id", organizationId).limit(20000);
    const platWids = new Set<string>();
    const platPhones = new Set<string>();
    for (const c of (platContacts as any[] ?? [])) {
      if (c.whaapy_contact_id) platWids.add(c.whaapy_contact_id);
      const d10 = digits(c.phone).slice(-10);
      if (d10.length === 10) platPhones.add(d10);
    }
    // paginar Whaapy /contacts/v1
    const whaapyContacts: Array<{ id: string; phone: string; source: string; agent: string | null }> = [];
    let cursor: string | null = null;
    let pages = 0;
    let total: number | null = null;
    do {
      const path = cursor ? `/contacts/v1?limit=100&cursor=${encodeURIComponent(cursor)}` : `/contacts/v1?limit=100`;
      let resp: any;
      try { resp = await whaapyRest<any>({ organizationId }, "GET", path); }
      catch (e) { console.log(`  list falló en page ${pages}: ${(e as Error).message}`); break; }
      const list = resp?.contacts ?? resp?.data ?? [];
      total = resp?.pagination?.total ?? total;
      for (const c of list) whaapyContacts.push({ id: c.id, phone: c.phone_number ?? "", source: c.source ?? "(sin)", agent: c.assigned_agent_id ?? null });
      cursor = resp?.pagination?.has_more ? resp?.pagination?.next_cursor ?? null : null;
      pages++;
    } while (cursor && pages < 100);
    console.log(`  Whaapy total (pagination.total)=${total} · recolectados=${whaapyContacts.length} en ${pages} páginas`);

    let missing = 0;
    const missingBySource = new Map<string, number>();
    const missingWithAgent = { yes: 0, no: 0 };
    const examples: string[] = [];
    for (const wc of whaapyContacts) {
      const d10 = digits(wc.phone).slice(-10);
      const inPlat = platWids.has(wc.id) || (d10.length === 10 && platPhones.has(d10));
      if (!inPlat) {
        missing++;
        missingBySource.set(wc.source, (missingBySource.get(wc.source) ?? 0) + 1);
        if (wc.agent) missingWithAgent.yes++; else missingWithAgent.no++;
        if (examples.length < 8) examples.push(`${wc.phone} source=${wc.source} agent=${wc.agent ? "sí" : "no"} id=${wc.id}`);
      }
    }
    console.log(`  contactos Whaapy SIN contraparte en plataforma: ${missing} / ${whaapyContacts.length}`);
    console.log(`    con agente asignado: ${missingWithAgent.yes} · sin agente: ${missingWithAgent.no}`);
    console.log(`    por source:`);
    for (const [k, v] of Array.from(missingBySource.entries()).sort()) console.log(`      ${k}: ${v}`);
    console.log(`    ejemplos:`);
    for (const ex of examples) console.log(`      ${ex}`);
  }, { source: "script" });
}

main().catch((e: Error) => { console.error("diagnose falló:", e.message); process.exit(1); });
