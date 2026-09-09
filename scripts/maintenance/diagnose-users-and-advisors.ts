/* eslint-disable no-console */
/**
 * DIAGNÓSTICO READ-ONLY (M9.2 — Block 0). NO escribe nada.
 *
 * Responde la pregunta que el repo no puede: ¿cómo existen Gina/Pepe HOY?
 *   - ¿Tienen membership real (role=vendedor, is_system_user=false)?
 *   - ¿Su auth.users tiene login usable (último sign-in, provider) o es
 *     un placeholder sin contraseña (como "Histórico")?
 *   - ¿O la atribución está cayendo en NULL / en el usuario "Histórico"?
 *
 * Para cada membership de la org imprime: rol, is_active, is_system_user,
 * nombre, email de auth, provider(s), last_sign_in_at, email_confirmed_at,
 * y conteos de opps (activas vs terminales vs canceladas), contactos y
 * órdenes atribuidas. Más: tag_mappings de vendedor → membership, y cuánta
 * atribución vive en NULL.
 *
 * Uso: npm run maintenance:diagnose-users-and-advisors -- --org-slug centr
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { getTenantScopedClient } from "@/lib/db/client";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

interface AuthInfo {
  email: string | null;
  provider: string | null;
  providers: string[];
  lastSignInAt: string | null;
  emailConfirmedAt: string | null;
  createdAt: string | null;
  isSystemMeta: boolean;
  identitiesCount: number;
  lookupError: string | null;
}

/**
 * Trae TODAS las filas de una tabla tenant-scoped, paginando de mil en mil.
 *
 * PostgREST aplica un tope por defecto de 1000 filas: una query sin paginar
 * devuelve una MUESTRA sin avisar — no hay error, no hay truncamiento visible,
 * solo un array corto. En un diagnóstico de atribución eso es peor que no
 * medir: los totales sumaban justo 1000 y los conteos por vendedor parecían
 * ENCOGER entre corridas, porque cada oportunidad nueva empujaba a otra fuera
 * de la muestra.
 *
 * Corta cuando una página vuelve incompleta (última página) o vacía.
 */
async function fetchAllRows(
  supabase: ReturnType<typeof getTenantScopedClient>["supabase"],
  table: "opportunities" | "contacts" | "orders",
  columns: string,
  organizationId: string,
): Promise<Array<Record<string, unknown>>> {
  const PAGE = 1000;
  const all: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq("organization_id", organizationId)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Array<Record<string, unknown>>;
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return all;
}

async function loadAuthUsersByIds(userIds: string[]): Promise<Map<string, AuthInfo>> {
  // listUsers() (bulk) falla con "Database error finding users" en este
  // entorno; resolvemos por getUserById que es targetado y evita el path bulk.
  const admin = getSupabaseAdminClient();
  const map = new Map<string, AuthInfo>();
  for (const id of userIds) {
    const { data, error } = await admin.auth.admin.getUserById(id);
    if (error || !data?.user) {
      map.set(id, {
        email: null,
        provider: null,
        providers: [],
        lastSignInAt: null,
        emailConfirmedAt: null,
        createdAt: null,
        isSystemMeta: false,
        identitiesCount: 0,
        lookupError: error?.message ?? "no user",
      });
      continue;
    }
    const u = data.user;
    const appMeta = (u.app_metadata ?? {}) as Record<string, unknown>;
    map.set(id, {
      email: u.email ?? null,
      provider: (appMeta.provider as string) ?? null,
      providers: (appMeta.providers as string[]) ?? [],
      lastSignInAt: u.last_sign_in_at ?? null,
      emailConfirmedAt: (u as { email_confirmed_at?: string | null }).email_confirmed_at ?? null,
      createdAt: u.created_at ?? null,
      isSystemMeta: appMeta.is_system_user === true || appMeta.provider === "system",
      identitiesCount: (u.identities ?? []).length,
      lookupError: null,
    });
  }
  return map;
}

async function main() {
  const slug = process.argv.includes("--org-slug")
    ? process.argv[process.argv.indexOf("--org-slug") + 1]
    : "centr";

  const org = await getOrganizationBySlug(slug);
  if (!org) {
    console.error(`org ${slug} no encontrada`);
    process.exit(1);
  }

  await withTenantContext(
    org.id as UUID,
    async () => {
      const { supabase, organizationId } = getTenantScopedClient();

      // 1) Memberships + perfil.
      const { data: memberships, error: mErr } = await supabase
        .from("memberships")
        .select(
          "id, user_id, role, is_active, is_advisor, whaapy_agent_id, created_at, profile:user_profiles(full_name, is_system_user, color)",
        )
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: true });
      if (mErr) throw mErr;

      const userIds = Array.from(
        new Set(((memberships ?? []) as Array<{ user_id: string }>).map((m) => m.user_id)),
      );
      const authUsers = await loadAuthUsersByIds(userIds);

      // 2) Tag mappings de vendedor.
      const { data: tagMaps } = await supabase
        .from("tag_mappings")
        .select("original_tag, mapped_membership_id, classification")
        .eq("organization_id", organizationId)
        .eq("classification", "vendor");
      const tagsByMembership = new Map<string, string[]>();
      for (const t of (tagMaps ?? []) as Array<Record<string, unknown>>) {
        const mid = (t.mapped_membership_id as string) ?? null;
        if (!mid) continue;
        const arr = tagsByMembership.get(mid) ?? [];
        arr.push(t.original_tag as string);
        tagsByMembership.set(mid, arr);
      }
      const unmappedVendorTags = ((tagMaps ?? []) as Array<Record<string, unknown>>)
        .filter((t) => !t.mapped_membership_id)
        .map((t) => t.original_tag as string);

      // 3) Conteos de atribución. PAGINADOS a propósito: PostgREST corta en
      // 1000 filas por defecto, y una sola query sin paginar devolvía una
      // MUESTRA silenciosa, no el total. El síntoma era engañoso — los conteos
      // sumaban exactamente 1000 y "atribuidas" parecía BAJAR entre corridas
      // (en realidad las opps nuevas empujaban a otras fuera de la muestra).
      // Un diagnóstico que miente es peor que no tenerlo: aquí se decide a
      // quién se le atribuye la venta.
      const opps = await fetchAllRows(
        supabase,
        "opportunities",
        "id, assigned_advisor_id, funnel, cancelled_at, won_at, lost_at",
        organizationId,
      );
      const contacts = await fetchAllRows(
        supabase,
        "contacts",
        "id, assigned_advisor_id",
        organizationId,
      );
      const orders = await fetchAllRows(
        supabase,
        "orders",
        "id, assigned_advisor_id",
        organizationId,
      );

      const NULL_KEY = "__NULL__";
      const oppStats = new Map<string, { active: number; won: number; lost: number; cancelled: number }>();
      for (const o of (opps ?? []) as Array<Record<string, unknown>>) {
        const k = (o.assigned_advisor_id as string) ?? NULL_KEY;
        const s = oppStats.get(k) ?? { active: 0, won: 0, lost: 0, cancelled: 0 };
        if (o.cancelled_at) s.cancelled += 1;
        else if (o.won_at) s.won += 1;
        else if (o.lost_at) s.lost += 1;
        else s.active += 1;
        oppStats.set(k, s);
      }
      const contactCount = new Map<string, number>();
      for (const c of (contacts ?? []) as Array<Record<string, unknown>>) {
        const k = (c.assigned_advisor_id as string) ?? NULL_KEY;
        contactCount.set(k, (contactCount.get(k) ?? 0) + 1);
      }
      const orderCount = new Map<string, number>();
      for (const o of (orders ?? []) as Array<Record<string, unknown>>) {
        const k = (o.assigned_advisor_id as string) ?? NULL_KEY;
        orderCount.set(k, (orderCount.get(k) ?? 0) + 1);
      }

      // ---- Output ----
      console.log(`\n=== M9.2 BLOCK 0 — USUARIOS & ASESORES (org=${slug}) ===\n`);
      console.log(`Memberships totales: ${memberships?.length ?? 0}\n`);

      for (const m of (memberships ?? []) as Array<Record<string, unknown>>) {
        const profile = (m.profile as { full_name?: string; is_system_user?: boolean; color?: string } | null) ?? null;
        const auth = authUsers.get(m.user_id as string) ?? null;
        const mid = m.id as string;
        const os = oppStats.get(mid) ?? { active: 0, won: 0, lost: 0, cancelled: 0 };
        const vendorTags = tagsByMembership.get(mid) ?? [];

        const loginUsed = auth?.lastSignInAt ? `sí (${auth.lastSignInAt})` : "NUNCA";
        const placeholder =
          auth?.isSystemMeta || (auth && !auth.lastSignInAt && !auth.emailConfirmedAt);

        console.log(`• ${profile?.full_name ?? "(sin perfil)"}  [membership ${mid}]`);
        console.log(`    role=${m.role}  is_active=${m.is_active}  is_system_user=${profile?.is_system_user ?? "?"}  color=${profile?.color ?? "-"}`);
        // Ranura de ASESOR (0050) — ortogonal al rol. Es la que decide si la
        // persona aparece en el selector de asesor, el mapeo de tags, el
        // desglose del dashboard y las metas. Se imprime junto al rol
        // justamente porque ANTES se confundían: un `role=admin` con
        // is_advisor=true es la líder que ascendió y conserva su cartera.
        console.log(`    is_advisor=${m.is_advisor}${m.is_advisor && m.role !== "vendedor" ? "  (opera cartera además de su rol)" : ""}`);
        console.log(`    auth.user_id=${m.user_id}`);
        console.log(`    email=${auth?.email ?? "(no encontrado en auth)"}${auth?.lookupError ? `  [lookup error: ${auth.lookupError}]` : ""}`);
        console.log(`    provider=${auth?.provider ?? "-"}  providers=[${auth?.providers.join(",") ?? ""}]  identities=${auth?.identitiesCount ?? "?"}`);
        console.log(`    login usado=${loginUsed}  email_confirmed=${auth?.emailConfirmedAt ?? "no"}`);
        console.log(`    => clasificación: ${profile?.is_system_user ? "SYSTEM (Histórico)" : placeholder ? "ASESOR REAL c/ login PLACEHOLDER (nunca accedió)" : "USUARIO con login real"}`);
        console.log(`    whaapy_agent_id=${m.whaapy_agent_id ?? "-"}`);
        console.log(`    tags de vendedor mapeadas: [${vendorTags.join(", ") || "ninguna"}]`);
        console.log(`    atribución: opps activas=${os.active} ganadas=${os.won} perdidas=${os.lost} canceladas=${os.cancelled} | contactos=${contactCount.get(mid) ?? 0} | órdenes=${orderCount.get(mid) ?? 0}`);
        console.log("");
      }

      console.log("--- Atribución SIN asignar (assigned_advisor_id NULL) ---");
      const onull = oppStats.get(NULL_KEY) ?? { active: 0, won: 0, lost: 0, cancelled: 0 };
      console.log(`  opps: activas=${onull.active} ganadas=${onull.won} perdidas=${onull.lost} canceladas=${onull.cancelled}`);
      console.log(`  contactos NULL=${contactCount.get(NULL_KEY) ?? 0}`);
      console.log(`  órdenes NULL=${orderCount.get(NULL_KEY) ?? 0}\n`);

      console.log("--- Tag mappings de vendedor SIN membership (mapped_membership_id NULL) ---");
      console.log(`  [${unmappedVendorTags.join(", ") || "ninguna"}]\n`);
    },
    { source: "script" },
  );
}

main().catch((e: Error) => {
  console.error("falló:", e.message);
  process.exit(1);
});
