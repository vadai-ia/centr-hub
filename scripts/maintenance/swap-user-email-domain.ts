/* eslint-disable no-console */
/**
 * Cambia el DOMINIO del correo de los usuarios de una organización,
 * conservando la parte local (`jose@viejo.com` → `jose@nuevo.com`).
 *
 * POR QUÉ EXISTE: cuando una empresa cambia de dominio corporativo hay que
 * mover el correo de todo el equipo a la vez. Hacerlo uno por uno desde la
 * UI es viable pero se presta a saltarse a alguien — y a quien se salte se
 * queda sin acceso el día que apaguen el dominio viejo.
 *
 * POR QUÉ POR DOMINIO Y NO POR LISTA: este repo es PÚBLICO. Una lista de
 * correos reales hardcodeada quedaría publicada en GitHub. El intercambio de
 * dominio expresa la misma intención sin meter ni un dato personal al código.
 *
 * QUÉ NO CAMBIA: el correo vive solo en `auth.users.email` (es la credencial
 * de login; no hay columna de email en memberships/user_profiles). El
 * `user_id` NO se toca, así que oportunidades, contactos, órdenes, tags y
 * mapeo de agentes de Whaapy quedan intactos — todas las FK cuelgan de
 * `membership.id`/`user_id`. Tampoco se invalida la sesión activa de nadie
 * (el RLS depende de `organization_id`, no del correo) ni se envía correo
 * alguno: comunicar el cambio es tarea del admin.
 *
 * ALCANCE: `auth.users` es GLOBAL, no por organización. Una persona con
 * membresías en varias orgs tiene UNA sola fila auth, así que el cambio
 * aplica a todas de una vez. La organización solo sirve para decidir A QUIÉN
 * tocar.
 *
 * Uso:
 *   npm run maintenance:swap-user-email-domain -- --org-slug centr \
 *     --from hybridsportssolutions.com --to hyve.fit
 *   ... y agregar --apply para escribir de verdad.
 *
 * Idempotente: al re-ejecutarlo ya nadie está en el dominio viejo y no hace
 * nada. Reversible: se corre otra vez con --from y --to invertidos.
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { withTenantContext } from "@/lib/tenant/context";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import {
  getAuthUserInfo,
  listManageableMemberships,
  repairAuthUserTokens,
  setAuthUserEmail,
} from "@/lib/db/users";
import { recordAuditEvent } from "@/lib/db/operational";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

interface CliArgs {
  orgSlug: string;
  fromDomain: string;
  toDomain: string;
  apply: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let orgSlug: string | null = null;
  let fromDomain: string | null = null;
  let toDomain: string | null = null;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--org-slug") orgSlug = argv[++i] ?? null;
    else if (arg === "--from") fromDomain = argv[++i] ?? null;
    else if (arg === "--to") toDomain = argv[++i] ?? null;
    else if (arg === "--apply") apply = true;
  }
  if (!orgSlug || !fromDomain || !toDomain) {
    console.error(
      "Uso: tsx swap-user-email-domain.ts --org-slug <slug> " +
        "--from <dominio-viejo> --to <dominio-nuevo> [--apply]",
    );
    process.exit(2);
  }
  const clean = (d: string) => d.trim().toLowerCase().replace(/^@/, "");
  return {
    orgSlug,
    fromDomain: clean(fromDomain),
    toDomain: clean(toDomain),
    apply,
  };
}

interface Plan {
  membershipId: string;
  userId: string;
  fullName: string;
  currentEmail: string;
  nextEmail: string;
  needsRepair: boolean;
}

async function main() {
  const { orgSlug, fromDomain, toDomain, apply } = parseArgs();
  if (fromDomain === toDomain) {
    console.error("El dominio de origen y el de destino son el mismo.");
    process.exit(2);
  }

  const org = await getOrganizationBySlug(orgSlug);
  if (!org) {
    console.error(`No existe la organización con slug "${orgSlug}".`);
    process.exit(1);
  }

  console.log(`\n=== CAMBIO DE DOMINIO DE CORREO (org=${orgSlug}) ===`);
  console.log(`   @${fromDomain}  →  @${toDomain}`);
  console.log(apply ? "   MODO: APLICAR (escribe)\n" : "   MODO: dry-run (no escribe)\n");

  const { plans, skipped } = await withTenantContext(org.id, async () => {
    // El usuario sistema "Histórico" nunca se lista aquí (R10).
    const memberships = await listManageableMemberships(org.id);
    const plans: Plan[] = [];
    const skipped: string[] = [];
    // Una persona puede tener varias membresías en la MISMA org; su fila auth
    // es una sola. Sin deduplicar, se intentaría el cambio dos veces y el
    // segundo intento fallaría por "correo ya en uso" (falso negativo).
    const seenUsers = new Set<string>();

    for (const m of memberships) {
      const info = await getAuthUserInfo(m.user_id);
      const email = info.email?.trim().toLowerCase() ?? null;
      const name = m.profile.full_name;

      if (!email) {
        skipped.push(`${name} — sin correo recuperable (fila auth placeholder)`);
        continue;
      }
      const at = email.lastIndexOf("@");
      const domain = at === -1 ? "" : email.slice(at + 1);
      if (domain !== fromDomain) {
        skipped.push(`${name} — ${email} (fuera del dominio de origen)`);
        continue;
      }
      if (seenUsers.has(m.user_id)) continue;
      seenUsers.add(m.user_id);

      plans.push({
        membershipId: m.id,
        userId: m.user_id,
        fullName: name,
        currentEmail: email,
        nextEmail: `${email.slice(0, at)}@${toDomain}`,
        needsRepair: info.loadError,
      });
    }
    return { plans, skipped };
  }, { source: "script" });

  if (skipped.length > 0) {
    console.log(`— Sin cambios (${skipped.length}):`);
    for (const s of skipped) console.log(`    · ${s}`);
    console.log("");
  }

  if (plans.length === 0) {
    console.log("Nadie está en el dominio de origen. Nada que hacer.\n");
    return;
  }

  console.log(`— A cambiar (${plans.length}):`);
  for (const p of plans) {
    console.log(`    · ${p.fullName}`);
    console.log(`        ${p.currentEmail}  →  ${p.nextEmail}`);
  }
  console.log("");

  if (!apply) {
    console.log("Dry-run: no se escribió nada. Agrega --apply para ejecutarlo.\n");
    return;
  }

  let ok = 0;
  const failures: string[] = [];
  for (const p of plans) {
    try {
      // Fila auth insertada por SQL crudo → reparar tokens antes de tocarla
      // (misma mecánica que "Vincular login"; ver ERRORES.md).
      if (p.needsRepair) await repairAuthUserTokens(p.userId);
      await setAuthUserEmail(p.userId, p.nextEmail);
      await withTenantContext(
        org.id,
        () =>
          recordAuditEvent({
            actorUserId: null,
            eventType: "user_email_updated",
            entityType: "membership",
            entityId: p.membershipId,
            payload: {
              previous_email: p.currentEmail,
              new_email: p.nextEmail,
              source: "swap-user-email-domain",
            },
          }),
        { source: "script" },
      );
      console.log(`    ✓ ${p.fullName} → ${p.nextEmail}`);
      ok += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`    ✗ ${p.fullName}: ${msg}`);
      failures.push(`${p.fullName} (${p.currentEmail}): ${msg}`);
    }
  }

  console.log(`\n${ok} de ${plans.length} actualizados.`);
  if (failures.length > 0) {
    console.log("\nFallaron:");
    for (const f of failures) console.log(`    · ${f}`);
    console.log(
      "\nEl resto SÍ se aplicó — el script es idempotente, puedes re-ejecutarlo " +
        "tras resolver la causa (correo duplicado, normalmente).",
    );
    process.exit(1);
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
