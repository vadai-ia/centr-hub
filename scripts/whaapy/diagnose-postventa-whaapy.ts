/* eslint-disable no-console */
/**
 * Diagnóstico (lectura pura) de la integración Post-venta ↔ Whaapy Post-venta
 * (webhooks 1–4): por qué un caso abierto/resuelto en un lado no aterriza en
 * el otro.
 *
 * Invariante de los scripts inspect y diagnose: NO escribe a BD propia, NO
 * modifica nada en Whaapy (el `POST /contacts/v1/search` de Whaapy es lectura).
 *
 * La señal que más veces resuelve el caso está en el bloque 7: un contacto
 * creado por la plataforma vía API llega con `conversations: []` y
 * `assigned_agent_id: null`. Las automatizaciones de Whaapy que dependen de
 * conversación (mensaje en "Caso Problemático", http_request en "Caso
 * Resuelto") no se observan disparando sobre esos contactos — comparar la
 * columna `conv` entre un contacto `source=api` y uno `source=webhook`.
 *
 * Uso:
 *   npm run whaapy:diagnose-postventa -- --org-slug centr
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import { getWhaapyPostventaApiKey } from "@/lib/vault";
import { WHAAPY_API_BASE } from "@/lib/whaapy/config";
import { WHAAPY_POSTVENTA_STAGE_NAMES } from "@/lib/whaapy-postventa/config";
import { normalizePhone } from "@/lib/services/identity-matching";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

/** Nombre EXACTO de la etapa sumidero en la plataforma (postventa-transition). */
const PLATFORM_PROBLEM_STAGE = "Caso problemático";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

interface WhaapyContact {
  id?: string;
  name?: string | null;
  phone_number?: string | null;
  source?: string | null;
  assigned_agent_id?: string | null;
  funnel_stage?: { id?: string; name?: string } | null;
  custom_fields?: Record<string, unknown> | null;
}

async function main(): Promise<void> {
  const orgSlug = arg("--org-slug", "centr");
  void getSupabaseAdminClient();
  const org = await getOrganizationBySlug(orgSlug);
  if (!org) {
    console.error(`org ${orgSlug} no encontrada`);
    process.exit(1);
  }
  console.log(`org: ${org.name} (${org.id})`);
  console.log(`whaapy base: ${WHAAPY_API_BASE}\n`);

  await withTenantContext(org.id as UUID, async () => {
    const { supabase, organizationId } = getTenantScopedClient();

    // ---------- 1) Config de la org ----------
    console.log("=== 1) Config de la org ===");
    const { data: orgRow } = await supabase
      .from("organizations")
      .select("*")
      .eq("id", organizationId)
      .single();
    const r = (orgRow ?? {}) as Record<string, unknown>;
    console.log(
      `  whaapy_postventa_business_id (0037): ${
        "whaapy_postventa_business_id" in r
          ? (r.whaapy_postventa_business_id ?? "(null) — no lo usa el inbound Option A (tenant por body.org)")
          : "(COLUMNA AUSENTE → migración 0037 no aplicada)"
      }`,
    );
    console.log(`  backfill_in_progress: ${r.backfill_in_progress ?? "(null)"}`);
    const bag = (r.vault_keys ?? {}) as Record<string, Record<string, unknown>>;
    const pv = bag.whaapy_postventa ?? {};
    const keyState = (k: string): string => {
      const v = pv[k];
      return typeof v === "string" && v.length > 0 ? `presente (len=${v.length})` : "AUSENTE";
    };
    console.log(`  vault whaapy_postventa.api_key:        ${keyState("api_key")}`);
    console.log(`  vault whaapy_postventa.inbound_token:  ${keyState("inbound_token")}  ← auth del webhook 3`);
    console.log(`  vault whaapy_postventa.webhook_secret: ${keyState("webhook_secret")}  ← no lo usa Option A`);
    const cfg = (r.config ?? {}) as Record<string, Record<string, unknown>>;
    console.log(`  config.postventa.resolver_user_id: ${cfg.postventa?.resolver_user_id ?? "(NO CONFIGURADO → el inbound no resuelve)"}`);
    console.log(
      `  POSTVENTA_WHAAPY_SYNC_ENABLED (este proceso): ${process.env.POSTVENTA_WHAAPY_SYNC_ENABLED ?? "(unset → OFF)"}` +
        "  ← el valor que importa es el de Vercel, no éste",
    );

    // ---------- 2) Etapas de la plataforma ----------
    console.log("\n=== 2) Etapas Post-venta (plataforma) ===");
    const { data: stages } = await supabase
      .from("pipeline_stages")
      .select("id,name,position,is_active")
      .eq("organization_id", organizationId)
      .eq("funnel", "post_venta")
      .order("position", { ascending: true });
    for (const s of stages ?? []) {
      console.log(`  pos ${String(s.position).padStart(2)} · ${s.name} (${s.id}) active=${s.is_active}`);
    }
    const problem = (stages ?? []).find((s) => s.name === PLATFORM_PROBLEM_STAGE) ?? null;
    console.log(`  → "${PLATFORM_PROBLEM_STAGE}": ${problem ? problem.id : "NO ENCONTRADO (rompe reopen + inbound)"}`);

    // ---------- 3) Etapas de Whaapy Post-venta ----------
    console.log("\n=== 3) Etapas del funnel (Whaapy Post-venta) ===");
    const apiKey = await getWhaapyPostventaApiKey(org.id as UUID);
    const whaapy = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${WHAAPY_API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      try {
        return { status: res.status, json: JSON.parse(text) as unknown };
      } catch {
        return { status: res.status, json: null as unknown };
      }
    };
    const stagesRes = await whaapy("GET", "/funnel/v1/stages");
    const wStages = ((stagesRes.json as { stages?: Array<{ id?: string; name?: string; position?: number; contact_count?: number }> })?.stages) ?? [];
    console.log(`  HTTP ${stagesRes.status} · ${wStages.length} etapa(s)`);
    for (const s of wStages) {
      console.log(`  pos ${s.position} · "${s.name}" (${s.id}) contactos=${s.contact_count ?? "?"}`);
    }
    console.log("  match de nombres que resuelve la integración:");
    for (const [key, name] of Object.entries(WHAAPY_POSTVENTA_STAGE_NAMES)) {
      const hit = wStages.find((s) => s.name === name);
      console.log(`    ${key.padEnd(18)} "${name}" → ${hit ? `OK ${hit.id}` : "NO EXISTE con ese nombre"}`);
    }

    // ---------- 4) Entradas a "Caso problemático" (plataforma) ----------
    console.log("\n=== 4) Entradas a Caso problemático (all-time) ===");
    if (problem) {
      const { data: hist } = await supabase
        .from("opportunity_stage_history")
        .select("opportunity_id,from_stage_id,context,changed_at")
        .eq("organization_id", organizationId)
        .eq("to_stage_id", problem.id)
        .order("changed_at", { ascending: false })
        .limit(50);
      console.log(`  ${hist?.length ?? 0} entrada(s):`);
      for (const h of hist ?? []) {
        console.log(`    ${h.changed_at} opp=${h.opportunity_id} ctx=${h.context} from=${h.from_stage_id ?? "∅"}`);
      }

      const { data: living } = await supabase
        .from("opportunities")
        .select("id,contact_id,display_reference,resolved_at")
        .eq("organization_id", organizationId)
        .eq("stage_id", problem.id);
      console.log(`\n  opps que HOY viven ahí: ${living?.length ?? 0}`);
      for (const o of living ?? []) {
        const { data: c } = await supabase
          .from("contacts")
          .select("full_name,phone")
          .eq("id", o.contact_id ?? "")
          .maybeSingle();
        const e164 = c?.phone ? normalizePhone(c.phone) : null;
        console.log(
          `    opp=${o.id} ref=${o.display_reference ?? "-"} resolved=${o.resolved_at ?? "no"} ` +
            `"${c?.full_name ?? "?"}" ${c?.phone ?? "(sin teléfono)"} → ${e164 ?? "NO NORMALIZA (normalizePhone solo acepta MX)"}`,
        );
      }
    }

    // ---------- 5) audit_log postventa_whaapy_* ----------
    console.log("\n=== 5) audit_log · postventa_whaapy_* (all-time) ===");
    const { data: al } = await supabase
      .from("audit_log")
      .select("event_type,entity_id,payload,created_at")
      .eq("organization_id", organizationId)
      .like("event_type", "postventa_whaapy%")
      .order("created_at", { ascending: true });
    if (!al?.length) console.log("  (ninguno — el outbound nunca se ejecutó)");
    for (const a of al ?? []) {
      console.log(`  ${a.created_at} ${a.event_type} entity=${a.entity_id ?? "-"} ${JSON.stringify(a.payload)}`);
    }

    // ---------- 6) whaapy_raw_webhooks (inbound webhook 3) ----------
    console.log("\n=== 6) whaapy_raw_webhooks endpoint='postventa' (inbound) ===");
    console.log("  (la fila se inserta ANTES de auth/parseo: sin fila = la request NUNCA llegó)");
    const { data: raw } = await supabase
      .from("whaapy_raw_webhooks")
      .select("received_at,exit_reason,raw_body")
      .eq("endpoint", "postventa")
      .order("received_at", { ascending: true })
      .limit(30);
    if (!raw?.length) console.log("  (ninguna request recibida jamás)");
    for (const w of raw ?? []) {
      console.log(`  ${w.received_at} exit=${w.exit_reason} body=${String(w.raw_body ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    }

    // ---------- 7) Contactos vivos en Whaapy Post-venta ----------
    console.log("\n=== 7) Contactos en el Whaapy Post-venta (estado real) ===");
    const list = await whaapy("POST", "/contacts/v1/search", { filters: {}, limit: 50 });
    const contacts = ((list.json as { contacts?: WhaapyContact[] })?.contacts) ?? [];
    console.log(`  HTTP ${list.status} · ${contacts.length} contacto(s)`);
    for (const c of contacts) {
      const detail = await whaapy("GET", `/contacts/v1/${c.id}`);
      const convs = ((detail.json as { conversations?: unknown[] })?.conversations) ?? [];
      const oppId = (c.custom_fields ?? {})[
        "centrhub_opportunity_id"
      ] as string | undefined;
      console.log(
        `\n    ${c.name ?? "(sin nombre)"} · ${c.phone_number}\n` +
          `      id=${c.id}\n` +
          `      etapa=${c.funnel_stage?.name ?? "(sin etapa)"}  source=${c.source}\n` +
          `      conv=${convs.length}  agente=${c.assigned_agent_id ?? "null"}` +
          `${convs.length === 0 ? "   ← SIN conversación: las automatizaciones de Whaapy no se observan disparando" : ""}\n` +
          `      centrhub_opportunity_id=${oppId ?? "(ninguno)"}`,
      );
      if (oppId) {
        const { data: o } = await supabase
          .from("opportunities")
          .select("id,stage_id,resolved_at")
          .eq("id", oppId)
          .maybeSingle();
        const { data: st } = o
          ? await supabase.from("pipeline_stages").select("name").eq("id", o.stage_id).maybeSingle()
          : { data: null };
        console.log(
          `      ↳ plataforma: ${o ? `etapa="${st?.name}" resolved=${o.resolved_at ?? "no"}` : "opp NO ENCONTRADA"}`,
        );
      }
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
