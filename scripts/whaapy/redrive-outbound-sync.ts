/* eslint-disable no-console */
/**
 * RE-SYNC outbound de contactos atascados (whaapy_contact_id NULL) — reproduce
 * FIELMENTE el create del worker usando el REAL `buildOutboundBody` (ya con el
 * fix omit-null) + `whaapyRestWith409`. En éxito enlaza whaapy_contact_id.
 *
 * Uso:
 *   ... redrive-outbound-sync.ts --org-slug centr --contact-id <uuid>
 *   ... redrive-outbound-sync.ts --org-slug centr --sweep     (todos los outbound atascados)
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getContactById, updateContact } from "@/lib/db/contacts";
import { recordAuditEvent } from "@/lib/db/operational";
import { markOutboundWrite } from "@/lib/services/sync-loop-defense";
import { whaapyRestWith409, WhaapyApiError } from "@/lib/whaapy/admin-client";
import { buildOutboundBody } from "@/lib/inngest/functions/whaapy-outbound";
import { PLATFORM_ORIGIN_MARKER } from "@/lib/constants";
import type { ContactRow, Json, UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function resolveAgentId(orgId: UUID, advisorId: UUID | null): Promise<string | null> {
  if (!advisorId) return null;
  const admin = getSupabaseAdminClient();
  const { data } = await admin
    .from("memberships")
    .select("whaapy_agent_id")
    .eq("organization_id", orgId)
    .eq("id", advisorId)
    .maybeSingle();
  return (data as { whaapy_agent_id: string | null } | null)?.whaapy_agent_id ?? null;
}

function extractExistingId(body: unknown): string | null {
  const b = body as { existing_contact_id?: string; contact?: { id?: string }; id?: string } | null;
  return b?.existing_contact_id ?? b?.contact?.id ?? b?.id ?? null;
}

type Outcome = { id: UUID; name: string | null; result: string };

async function reSync(orgId: UUID, contact: ContactRow): Promise<Outcome> {
  const tag = `${contact.full_name ?? "(sin nombre)"} [${contact.id.slice(0, 8)}]`;
  if (contact.whaapy_contact_id) return { id: contact.id, name: contact.full_name, result: "ya_enlazado" };
  if (!contact.phone || contact.missing_phone) return { id: contact.id, name: contact.full_name, result: "sin_telefono" };

  const agentId = await resolveAgentId(orgId, contact.assigned_advisor_id);
  const snapshot = {
    shopifyCustomerId: contact.shopify_customer_id,
    whaapyContactId: contact.whaapy_contact_id,
    fullName: contact.full_name,
    email: contact.email,
    phone: contact.phone,
    address: contact.address,
    internalNote: contact.internal_note,
    shopifyTags: contact.shopify_tags,
    shopifyState: contact.shopify_state,
    assignedAdvisorId: contact.assigned_advisor_id,
    fieldMetadata: contact.field_metadata,
    lastModifiedAt: contact.last_modified_at,
    lastModifiedSource: contact.last_modified_source,
  };
  // Redrive es siempre CREATE → set si hay agente mapeado, omit si no
  // (nunca clear: en create no hay agente que limpiar).
  const body = buildOutboundBody(
    snapshot,
    agentId ? { kind: "set", id: agentId } : { kind: "omit" },
  );
  await markOutboundWrite({ contactId: contact.id, source: PLATFORM_ORIGIN_MARKER });

  try {
    const res = await whaapyRestWith409<{ contact?: { id?: string }; id?: string }>({ organizationId: orgId }, "POST", "/contacts/v1", body);
    if (res.ok) {
      // Respuesta envuelta: { contact: { id } } (no flat {id}).
      const createdId = res.data?.contact?.id ?? res.data?.id ?? null;
      if (createdId) {
        await updateContact(contact.id, { whaapy_contact_id: createdId });
        await recordAuditEvent({
          actorUserId: null, eventType: "whaapy_contact_created_outbound", entityType: "contact",
          entityId: contact.id, payload: { whaapy_contact_id: createdId, via: "redrive_script", agent: agentId } as Json,
        });
        console.log(`  ✅ ${tag} → creado ${createdId}${agentId ? ` (agente ${agentId.slice(0, 8)})` : ""}`);
        return { id: contact.id, name: contact.full_name, result: `creado:${createdId}` };
      }
      console.log(`  ⚠️  ${tag} → 2xx sin id`);
      return { id: contact.id, name: contact.full_name, result: "2xx_sin_id" };
    }
    // 409 → enlazar existente.
    const existing = extractExistingId(res.body);
    if (existing) {
      try {
        await updateContact(contact.id, { whaapy_contact_id: existing });
      } catch (e) {
        if ((e as { code?: string })?.code === "23505") {
          console.log(`  ⏭️  ${tag} → duplicado local: el Whaapy ${existing.slice(0, 8)} ya está enlazado a OTRO contacto`);
          return { id: contact.id, name: contact.full_name, result: `duplicado_local:${existing}` };
        }
        throw e;
      }
      console.log(`  ✅ ${tag} → 409 enlazado a ${existing}`);
      return { id: contact.id, name: contact.full_name, result: `enlazado_409:${existing}` };
    }
    console.log(`  ⚠️  ${tag} → 409 sin existing_id: ${JSON.stringify(res.body)}`);
    return { id: contact.id, name: contact.full_name, result: "409_sin_id" };
  } catch (err) {
    if (err instanceof WhaapyApiError) {
      console.log(`  ❌ ${tag} → status=${err.status} body=${JSON.stringify(err.body).slice(0, 200)}`);
      await recordAuditEvent({
        actorUserId: null, eventType: "whaapy_outbound_failed", entityType: "contact", entityId: contact.id,
        payload: { reason: "create_from_platform_ui", phase: "create", status: err.status, body_excerpt: JSON.stringify(err.body).slice(0, 500), via: "redrive_script" } as Json,
      });
      return { id: contact.id, name: contact.full_name, result: `error_${err.status}` };
    }
    throw err;
  }
}

async function main() {
  const slug = arg("--org-slug") ?? "centr";
  const org = await getOrganizationBySlug(slug);
  if (!org) throw new Error(`org ${slug} no encontrada`);
  const admin = getSupabaseAdminClient();

  await withTenantContext(org.id, async () => {
    const single = arg("--contact-id");
    let contacts: ContactRow[] = [];
    if (single) {
      const c = await getContactById(single);
      if (c) contacts = [c];
    } else if (process.argv.includes("--sweep")) {
      const { data } = await admin
        .from("contacts")
        .select("*")
        .eq("organization_id", org.id)
        .eq("is_outbound", true)
        .is("whaapy_contact_id", null)
        .eq("missing_phone", false)
        .not("phone", "is", null);
      contacts = (data ?? []) as ContactRow[];
    } else {
      console.log("Pasa --contact-id <uuid> o --sweep");
      return;
    }

    console.log(`\nRe-sync de ${contacts.length} contacto(s) outbound atascado(s):\n`);
    const outcomes: Outcome[] = [];
    for (const c of contacts) outcomes.push(await reSync(org.id, c));

    const recovered = outcomes.filter((o) => o.result.startsWith("creado") || o.result.startsWith("enlazado"));
    const failed = outcomes.filter((o) => o.result.startsWith("error") || o.result.includes("sin_id"));
    console.log(`\n=== RESUMEN ===`);
    console.log(`Recuperados (${recovered.length}): ${recovered.map((o) => o.name).join(", ") || "-"}`);
    console.log(`Fallidos (${failed.length}): ${failed.map((o) => `${o.name}(${o.result})`).join(", ") || "-"}`);
  });
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
