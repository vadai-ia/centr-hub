/* eslint-disable no-console */
/**
 * SEED "Vendedor Prueba" (M9.2, Block 5). Crea un vendedor de prueba con
 * login inmediato (email + contraseña, email_confirm=true) para validar
 * el milestone — invitación/vista de vendedor/reasignación/desactivación
 * — SIN tocar a Gina/Pepe ni datos reales.
 *
 * A diferencia del flujo "Invitar" de la UI (que manda email built-in),
 * este seed fija la contraseña directo para que el operador pueda hacer
 * login de inmediato como Vendedor Prueba en el checkpoint.
 *
 * Idempotente: si ya existe un membership "Vendedor Prueba" en la org, no
 * hace nada.
 *
 * Uso:
 *   npm run maintenance:seed-test-vendor -- --org-slug centr --email vendedor.prueba@centr.test --password 'UnaClaveSegura123'
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOrganizationBySlug } from "@/lib/db/organizations";
import {
  createMembership,
  createUserProfile,
  listManageableMemberships,
} from "@/lib/db/users";
import { withTenantContext } from "@/lib/tenant/context";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

const TEST_VENDOR_NAME = "Vendedor Prueba";
const TEST_VENDOR_COLOR = "#14B8A6"; // teal — distinto a Gina/Pepe

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const slug = arg("--org-slug", "centr")!;
  const email = (arg("--email", "vendedor.prueba@centr.test") ?? "").toLowerCase();
  const password = arg("--password");

  if (!password) {
    console.error("Falta --password. Uso: --org-slug centr --email <e> --password <p>");
    process.exit(1);
  }

  const org = await getOrganizationBySlug(slug);
  if (!org) {
    console.error(`org ${slug} no encontrada`);
    process.exit(1);
  }

  await withTenantContext(
    org.id as UUID,
    async () => {
      // Idempotencia: ¿ya existe "Vendedor Prueba" en la org?
      const existing = await listManageableMemberships(org.id as UUID);
      const already = existing.find((m) => m.profile.full_name === TEST_VENDOR_NAME);
      if (already) {
        console.log(
          `Ya existe "${TEST_VENDOR_NAME}" (membership ${already.id}, activo=${already.is_active}). No-op.`,
        );
        return;
      }

      const admin = getSupabaseAdminClient();
      const created = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: TEST_VENDOR_NAME },
      });
      if (created.error || !created.data?.user) {
        console.error(
          `No se pudo crear el auth user (${email}): ${created.error?.message ?? "desconocido"}. ` +
            "Si el email ya existe, pasá otro --email.",
        );
        process.exit(1);
      }
      const userId = created.data.user.id as UUID;

      await createUserProfile({
        id: userId,
        full_name: TEST_VENDOR_NAME,
        phone: null,
        avatar_url: null,
        color: TEST_VENDOR_COLOR,
        is_system_user: false,
      });
      await createMembership({
        user_id: userId,
        organization_id: org.id as UUID,
        role: "vendedor",
        is_active: true,
        whaapy_agent_id: null,
      });

      console.log(`✓ "${TEST_VENDOR_NAME}" creado.`);
      console.log(`  email:    ${email}`);
      console.log(`  password: (la que pasaste)`);
      console.log(`  user_id:  ${userId}`);
      console.log("");
      console.log("Para validar la vista de vendedor:");
      console.log("  1. Entrá en una ventana privada a /login con ese email/clave.");
      console.log("  2. Confirmá que solo ve SU pipeline/dashboard/contactos.");
      console.log("  3. Como admin, reasigná una opp a Vendedor Prueba (detalle de opp)");
      console.log("     y verificá que aparece en su vista; luego reasigná de vuelta.");
    },
    { source: "script" },
  );
}

main().catch((e: Error) => {
  console.error("falló:", e.message);
  process.exit(1);
});
