/* eslint-disable no-console */
/**
 * CLONA EL EQUIPO de una organización a otra (alta de una tienda nueva).
 *
 * Las mismas personas operan varias tiendas (Gina/Pepe/Daniela venden en
 * Centr y en Ruster; Elías es el Customer Success de todas). El modelo ya
 * lo soporta: `user_profiles` es GLOBAL (una fila por persona) y
 * `memberships` es POR ORGANIZACIÓN. Clonar = crear un membership más para
 * el MISMO `user_id` en la org destino → la persona entra con su mismo
 * correo y contraseña y cambia de tienda con el selector de organización.
 *
 * Por qué un script y no Admin → Usuarios: `inviteUserAction` crea un auth
 * user NUEVO y GoTrue rechaza un email ya registrado ("Ese email ya tiene
 * una cuenta"). La UI no tiene camino para sumar a la org una persona que
 * ya existe en otra. Duplicarla con otro correo rompería el modelo (dos
 * identidades para la misma persona) — este script reusa el `user_id`.
 *
 * Qué hace, en orden:
 *   1. Resuelve las personas en la org ORIGEN por su nombre de perfil.
 *   2. Si el rol de alguna no existe en la org DESTINO (caso típico:
 *      `customer-success`, que no siembra `bootstrap_organization`), lo
 *      copia tal cual desde la origen. Audit `role_created`.
 *   3. Crea el membership en la org DESTINO reusando `user_id`, rol,
 *      is_active e in_lead_rotation de la origen. Audit `membership_created`.
 *      `whaapy_agent_id` queda en NULL a propósito: el Whaapy de la org
 *      destino es OTRO negocio, sus agent ids no son los de la origen
 *      (se mapean después en Admin → Agentes Whaapy).
 *   4. Si se clonó un Customer Success, ancla
 *      `organizations.config.postventa.customer_success_membership_id`
 *      (migración 0047) y backfillea las opps de Post-venta sin CS.
 *
 * Idempotente: una persona que ya tiene membership en el destino se omite
 * (y se avisa si su rol allá difiere — NO se pisa). Todo se valida ANTES
 * de escribir: si un nombre no existe en la origen, aborta sin tocar nada.
 *
 * Uso:
 *   npm run maintenance:clone-org-team -- --from centr --to rustr \
 *     --members "Gina Jiménez,Pepe,Daniela Leyva,Elías" --dry-run
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import { createMembership } from "@/lib/db/users";
import { recordAuditEvent } from "@/lib/db/operational";
import { withTenantContext } from "@/lib/tenant/context";
import { CUSTOMER_SUCCESS_ROLE_KEY } from "@/lib/auth/capabilities";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DRY_RUN = process.argv.includes("--dry-run");

interface SourceMember {
  membershipId: string;
  userId: string;
  fullName: string;
  role: string;
  isActive: boolean;
  inLeadRotation: boolean;
  isSystem: boolean;
}

interface RoleDef {
  key: string;
  label: string;
  data_scope: string;
  allowed_tabs: string[];
  is_system: boolean;
}

async function loadMembers(organizationId: string): Promise<SourceMember[]> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("memberships")
    .select(
      "id, user_id, role, is_active, in_lead_rotation, profile:user_profiles(full_name, is_system_user)",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? [])
    .map((m) => {
      const p = (m.profile ?? {}) as { full_name?: string; is_system_user?: boolean };
      return {
        membershipId: m.id as string,
        userId: m.user_id as string,
        fullName: p.full_name ?? "",
        role: m.role as string,
        isActive: m.is_active as boolean,
        inLeadRotation: m.in_lead_rotation as boolean,
        isSystem: p.is_system_user === true,
      };
    })
    .filter((m) => !m.isSystem);
}

async function loadRoles(organizationId: string): Promise<Map<string, RoleDef>> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("roles")
    .select("key, label, data_scope, allowed_tabs, is_system")
    .eq("organization_id", organizationId);
  if (error) throw error;
  return new Map((data ?? []).map((r) => [r.key as string, r as unknown as RoleDef]));
}

const norm = (s: string) => s.trim().toLocaleLowerCase("es");

async function main() {
  const fromSlug = arg("--from") ?? "centr";
  const toSlug = arg("--to");
  const membersRaw = arg("--members");

  if (!toSlug || !membersRaw) {
    console.error(
      'Uso: --from centr --to rustr --members "Gina Jiménez,Pepe,Daniela Leyva,Elías" [--dry-run]',
    );
    process.exit(1);
  }
  if (fromSlug === toSlug) {
    console.error("--from y --to no pueden ser la misma organización.");
    process.exit(1);
  }

  const [source, target] = await Promise.all([
    getOrganizationBySlug(fromSlug),
    getOrganizationBySlug(toSlug),
  ]);
  if (!source) {
    console.error(`org origen "${fromSlug}" no encontrada`);
    process.exit(1);
  }
  if (!target) {
    console.error(`org destino "${toSlug}" no encontrada`);
    process.exit(1);
  }

  const wanted = membersRaw.split(",").map((s) => s.trim()).filter(Boolean);

  const [srcMembers, tgtMembers, srcRoles, tgtRoles] = await Promise.all([
    loadMembers(source.id),
    loadMembers(target.id),
    loadRoles(source.id),
    loadRoles(target.id),
  ]);

  // --- Resolución + validación TOTAL antes de escribir nada -------------
  const resolved: SourceMember[] = [];
  const errors: string[] = [];
  for (const name of wanted) {
    const hits = srcMembers.filter((m) => norm(m.fullName) === norm(name));
    if (hits.length === 0) {
      errors.push(`No existe "${name}" en ${fromSlug}.`);
    } else if (hits.length > 1) {
      errors.push(`"${name}" es ambiguo en ${fromSlug} (${hits.length} memberships).`);
    } else {
      resolved.push(hits[0]);
    }
  }
  if (errors.length > 0) {
    console.error(`\n✗ Abortado sin escribir nada:\n  - ${errors.join("\n  - ")}`);
    console.error(`\n  Nombres disponibles en ${fromSlug}:`);
    for (const m of srcMembers) console.error(`    · ${m.fullName}  (role=${m.role})`);
    process.exit(1);
  }

  // --- Plan ------------------------------------------------------------
  const rolesToCreate: RoleDef[] = [];
  const toCreate: SourceMember[] = [];
  const skipped: string[] = [];

  for (const m of resolved) {
    const already = tgtMembers.find((t) => t.userId === m.userId);
    if (already) {
      skipped.push(
        already.role === m.role
          ? `${m.fullName}: ya tiene membership en ${toSlug} (role=${already.role}) — sin cambios.`
          : `${m.fullName}: YA existe en ${toSlug} con role="${already.role}" ≠ "${m.role}" de ${fromSlug}. NO se pisa; cámbialo desde Admin → Usuarios si corresponde.`,
      );
      continue;
    }
    if (!tgtRoles.has(m.role) && !rolesToCreate.some((r) => r.key === m.role)) {
      const def = srcRoles.get(m.role);
      if (!def) {
        console.error(
          `✗ El rol "${m.role}" de ${m.fullName} no existe ni en ${fromSlug}. Abortado.`,
        );
        process.exit(1);
      }
      rolesToCreate.push(def);
    }
    toCreate.push(m);
  }

  const csToCreate = toCreate.filter((m) => m.role === CUSTOMER_SUCCESS_ROLE_KEY);
  const targetConfig = (target.config ?? {}) as Record<string, unknown>;
  const postventaCfg = (targetConfig.postventa ?? {}) as Record<string, unknown>;
  const existingAnchor = (postventaCfg.customer_success_membership_id as string) ?? null;
  const willAnchor = csToCreate.length > 0 && !existingAnchor;

  let pvWithoutCs = 0;
  if (csToCreate.length > 0) {
    const admin = getSupabaseAdminClient();
    const { count } = await admin
      .from("opportunities")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", target.id)
      .eq("funnel", "post_venta")
      .is("customer_success_membership_id", null);
    pvWithoutCs = count ?? 0;
  }

  console.log(
    `\n=== CLONAR EQUIPO ${fromSlug} → ${toSlug} ${DRY_RUN ? "(DRY RUN — no escribe) " : ""}===\n`,
  );
  console.log(`Roles a crear en ${toSlug}: ${rolesToCreate.length === 0 ? "ninguno" : ""}`);
  for (const r of rolesToCreate) {
    console.log(
      `  + rol "${r.key}" (label="${r.label}", scope=${r.data_scope}, tabs=[${r.allowed_tabs.join(", ")}])`,
    );
  }
  console.log(`\nMemberships a crear: ${toCreate.length === 0 ? "ninguno" : ""}`);
  for (const m of toCreate) {
    console.log(
      `  + ${m.fullName.padEnd(16)} role=${m.role.padEnd(17)} active=${m.isActive} rotation=${m.inLeadRotation} user_id=${m.userId}`,
    );
  }
  if (skipped.length > 0) {
    console.log(`\nOmitidos:`);
    for (const s of skipped) console.log(`  · ${s}`);
  }
  if (csToCreate.length > 0) {
    console.log(`\nCustomer Success:`);
    console.log(
      willAnchor
        ? `  + ancla config.postventa.customer_success_membership_id → ${csToCreate[0].fullName}`
        : `  · ancla ya existente (${existingAnchor}) — no se toca`,
    );
    console.log(
      `  + backfill de ${pvWithoutCs} oportunidad(es) de Post-venta sin Customer Success`,
    );
  }

  if (DRY_RUN) {
    console.log(`\n(dry run) Nada escrito. Quitá --dry-run para aplicar.\n`);
    return;
  }
  if (rolesToCreate.length === 0 && toCreate.length === 0) {
    console.log(`\nNada que hacer.\n`);
    return;
  }

  // --- Aplicar ---------------------------------------------------------
  const admin = getSupabaseAdminClient();
  await withTenantContext(
    target.id as UUID,
    async () => {
      for (const r of rolesToCreate) {
        const { error } = await admin.from("roles").insert({
          organization_id: target.id as UUID,
          key: r.key,
          label: r.label,
          data_scope: r.data_scope as RoleDef["data_scope"],
          allowed_tabs: r.allowed_tabs,
          // Nunca se clona como rol de sistema: los de sistema ya existen
          // en toda org y un custom debe seguir siendo editable/borrable.
          is_system: false,
        } as never);
        if (error) throw error;
        await recordAuditEvent({
          eventType: "role_created",
          entityType: "role",
          payload: { key: r.key, label: r.label, cloned_from_organization: fromSlug },
        });
        console.log(`✓ rol "${r.key}" creado en ${toSlug}`);
      }

      let firstCsMembershipId: string | null = null;
      for (const m of toCreate) {
        const created = await createMembership({
          user_id: m.userId as UUID,
          organization_id: target.id as UUID,
          role: m.role,
          is_active: m.isActive,
          whaapy_agent_id: null,
          in_lead_rotation: m.inLeadRotation,
        });
        if (m.role === CUSTOMER_SUCCESS_ROLE_KEY && !firstCsMembershipId) {
          firstCsMembershipId = created.id;
        }
        await recordAuditEvent({
          eventType: "membership_created",
          entityType: "membership",
          entityId: created.id as UUID,
          payload: {
            full_name: m.fullName,
            role: m.role,
            user_id: m.userId,
            cloned_from_organization: fromSlug,
            source_membership_id: m.membershipId,
          },
        });
        console.log(`✓ ${m.fullName} → membership ${created.id} (role=${m.role})`);
      }

      if (firstCsMembershipId && !existingAnchor) {
        const nextConfig = {
          ...targetConfig,
          postventa: {
            ...postventaCfg,
            customer_success_membership_id: firstCsMembershipId,
          },
        };
        const { error } = await admin
          .from("organizations")
          .update({ config: nextConfig as never })
          .eq("id", target.id);
        if (error) throw error;
        console.log(
          `✓ ancla postventa.customer_success_membership_id → ${firstCsMembershipId}`,
        );
      }

      const csId = existingAnchor ?? firstCsMembershipId;
      if (csId) {
        const { data: patched, error } = await admin
          .from("opportunities")
          .update({ customer_success_membership_id: csId as UUID })
          .eq("organization_id", target.id)
          .eq("funnel", "post_venta")
          .is("customer_success_membership_id", null)
          .select("id");
        if (error) throw error;
        const n = (patched ?? []).length;
        if (n > 0) {
          await recordAuditEvent({
            eventType: "postventa_customer_success_backfilled",
            entityType: "opportunity",
            payload: { customer_success_membership_id: csId, opportunities: n },
          });
        }
        console.log(`✓ backfill Post-venta: ${n} oportunidad(es) con Customer Success`);
      }
    },
    { source: "script" },
  );

  console.log(
    `\nListo. Pendiente aparte para ${toSlug}: mapear los agentes de Whaapy ` +
      `(Admin → Agentes Whaapy) y las etiquetas de vendedor de su Shopify ` +
      `(Admin → Mapeo de tags).\n`,
  );
}

main().catch((e: Error) => {
  console.error("falló:", e.message);
  process.exit(1);
});
