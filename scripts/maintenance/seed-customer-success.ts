/* eslint-disable no-console */
/**
 * SEED "Customer Success" — la persona real que atiende los casos de
 * Post-venta en Whaapy. Es a quien se atribuye la resolución de un caso
 * originada en Whaapy (webhook 3 → `resolvePostventaCase` con
 * `resolved_by_user_id` = este user; FK a user_profiles.id).
 *
 * Se crea vía GoTrue (`admin.auth.admin.createUser`) — NUNCA por SQL
 * crudo (un insert directo en auth.users deja columnas de token en NULL
 * y GoTrue revienta; ver ERRORES.md "auth.users insertado por SQL crudo").
 *
 * Login LATENTE: se crea SIN contraseña. La persona opera en Whaapy, no
 * necesita entrar a la plataforma para que la atribución funcione (el
 * webhook 3 corre server-side con service_role). Si más adelante Centr
 * quiere darle acceso, se le envía la invitación desde Admin → Usuarios
 * sin recrear nada (repair-in-place preserva el user_id).
 *
 * Rol: `vendedor` (modelo M9.2: asesor = membership vendedor; mínimo
 * privilegio). Cambiable a admin desde Admin → Usuarios si hiciera falta.
 *
 * Idempotente: si ya existe un membership "Customer Success" en la org,
 * imprime su user_id y no hace nada.
 *
 * Ancla la atribución del webhook 3 por `user_id` ESTABLE: escribe
 * `organizations.config.postventa.resolver_user_id`. Editar email/nombre
 * de este usuario después NO cambia el user_id → la atribución no se rompe.
 *
 * Uso:
 *   npm run maintenance:seed-customer-success -- --org-slug centr --email customer.success@centr.test
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
import { storePostventaResolverUserId } from "@/lib/whaapy-postventa/resolver-user";
import { withTenantContext } from "@/lib/tenant/context";
import type { UUID } from "@/lib/types/database";

loadDotenv({ path: resolve(process.cwd(), ".env.local") });

const CS_NAME = "Customer Success";
const CS_COLOR = "#8B5CF6"; // violeta — distinto a Gina/Pepe/Prueba

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const slug = arg("--org-slug", "centr")!;
  const email = (arg("--email") ?? "").toLowerCase();

  if (!email) {
    console.error("Falta --email. Uso: --org-slug centr --email customer.success@centr.test");
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
      // Idempotencia: ¿ya existe "Customer Success" en la org?
      const existing = await listManageableMemberships(org.id as UUID);
      const already = existing.find((m) => m.profile.full_name === CS_NAME);
      if (already) {
        // Idempotente + reafirma el ancla estable: apunta el resolutor a
        // su user_id (por si el config no estaba puesto).
        await storePostventaResolverUserId(org.id as UUID, already.user_id as UUID);
        console.log(
          `Ya existe "${CS_NAME}" (membership ${already.id}, user ${already.user_id}). ` +
            `Resolutor Post-venta apuntado a ese user_id.`,
        );
        return;
      }

      const admin = getSupabaseAdminClient();
      // Login latente: sin password. email_confirm=false → cuenta creada
      // pero sin sesión hasta que se le envíe una invitación desde la UI.
      const created = await admin.auth.admin.createUser({
        email,
        email_confirm: false,
        user_metadata: { full_name: CS_NAME },
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
        full_name: CS_NAME,
        phone: null,
        avatar_url: null,
        color: CS_COLOR,
        is_system_user: false,
      });
      await createMembership({
        user_id: userId,
        organization_id: org.id as UUID,
        role: "vendedor",
        is_active: true,
        whaapy_agent_id: null,
      });

      // Ancla ESTABLE del resolutor: guarda el user_id en
      // organizations.config.postventa.resolver_user_id. Editar el
      // email/nombre de este usuario después NO cambia el user_id → la
      // atribución del webhook 3 nunca se rompe.
      await storePostventaResolverUserId(org.id as UUID, userId);

      console.log(`✓ "${CS_NAME}" creado (login latente, sin contraseña).`);
      console.log(`  email:    ${email}`);
      console.log(`  user_id:  ${userId}`);
      console.log(
        `  resolutor Post-venta → user_id ${userId} ` +
          `(organizations.config.postventa.resolver_user_id).`,
      );
      console.log("");
      console.log("El webhook 3 atribuye a este user_id (estable). Para cambiar la persona,");
      console.log("editá su email/nombre en Admin → Usuarios (el user_id no cambia).");
    },
    { source: "script" },
  );
}

main().catch((e: Error) => {
  console.error("falló:", e.message);
  process.exit(1);
});
