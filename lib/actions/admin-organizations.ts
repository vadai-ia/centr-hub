"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSession, type OrgWithRole, type SessionData } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/tenant/context";
import { hasTab, type RoleCapabilities } from "@/lib/auth/capabilities";
import {
  bootstrapOrganizationWithOwner,
  listOrganizationsByIds,
  slugExists,
  updateOrganization,
} from "@/lib/db/organizations";
import { getRoleByKey } from "@/lib/db/roles";
import { getUserProfile, listMembershipsForOrganization } from "@/lib/db/users";
import { recordAuditEvent } from "@/lib/db/operational";
import {
  ORG_SLUG_MAX_LENGTH,
  deriveOrgSlug,
  validateOrgSlug,
} from "@/lib/services/organization-slug";
import type { UUID } from "@/lib/types/database";
import type {
  CreateOrganizationResult,
  OrganizationAdminView,
  OrganizationsActionResult,
} from "@/lib/types/admin";

/**
 * Server actions de Admin → Organizaciones (0048). Crear una tienda nueva
 * y cambiarle el nombre visible a una existente, sin SQL.
 *
 * Autorización — es la única pantalla que opera CRUZANDO organizaciones, así
 * que no le basta `resolveAdminContext` (que solo mira la org ACTIVA de la
 * sesión). El gate real es por-organización: para tocar la org X, el usuario
 * debe tener membresía ACTIVA en X y que el rol de esa membresía incluya la
 * pestaña `admin-organizaciones`. Ser admin en Centr no autoriza a renombrar
 * Rustr si ahí no eres nada — el aislamiento multi-tenant se conserva.
 *
 * Lo que la pantalla deliberadamente NO hace:
 *  - Cambiar el `slug`: es el discriminador del webhook de Post-venta y de
 *    los scripts (`--org-slug`). Solo se elige al crear (ver
 *    `lib/services/organization-slug.ts`).
 *  - Capturar credenciales o ids externos: eso vive en Admin → Integraciones,
 *    con sus propias guardas (0046). Aquí una org nace sin conectar.
 *  - Borrar organizaciones: un tenant con datos no se borra desde una UI.
 */

const REQUIRED_TAB = "admin-organizaciones";

interface AuthorizedOrg {
  org: OrgWithRole;
  caps: RoleCapabilities;
}

/**
 * Organizaciones de la sesión donde el usuario PUEDE administrar
 * organizaciones. Resuelve el rol de cada membresía (no solo el de la org
 * activa) porque el mismo usuario puede ser admin en una y vendedor en otra.
 */
async function authorizedOrgs(session: SessionData): Promise<AuthorizedOrg[]> {
  const out: AuthorizedOrg[] = [];
  for (const org of session.orgs) {
    const caps =
      org.id === session.activeOrg.id
        ? session.activeRole
        : await capsFor(org.id, org.role);
    if (caps && hasTab(caps, REQUIRED_TAB)) out.push({ org, caps });
  }
  return out;
}

async function capsFor(orgId: UUID, roleKey: string): Promise<RoleCapabilities | null> {
  const row = await getRoleByKey(orgId, roleKey);
  if (!row) return null;
  return {
    key: row.key,
    label: row.label,
    dataScope: row.data_scope,
    allowedTabs: row.allowed_tabs,
    isSystem: row.is_system,
  };
}

type Resolution =
  | { ok: true; session: SessionData; authorized: AuthorizedOrg[] }
  | { ok: false; message: string };

async function resolve(): Promise<Resolution> {
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, message: "Sesión expirada. Vuelve a iniciar sesión." };
  }
  const authorized = await authorizedOrgs(session.data);
  if (authorized.length === 0) {
    return { ok: false, message: "No tienes permisos para esta sección." };
  }
  return { ok: true, session: session.data, authorized };
}

/** Miembros activos de la org, sin el usuario sistema "Histórico" (R10). */
async function countRealMembers(orgId: UUID): Promise<number> {
  const memberships = await listMembershipsForOrganization(orgId);
  let n = 0;
  for (const m of memberships) {
    if (!m.is_active) continue;
    const profile = await getUserProfile(m.user_id);
    if (profile?.is_system_user) continue;
    n += 1;
  }
  return n;
}

async function buildView(
  session: SessionData,
  authorized: AuthorizedOrg[],
): Promise<OrganizationAdminView[]> {
  const rows = await listOrganizationsByIds(authorized.map((a) => a.org.id));
  const capsById = new Map(authorized.map((a) => [a.org.id, a.caps]));
  const views: OrganizationAdminView[] = [];
  for (const row of rows) {
    views.push({
      id: row.id,
      name: row.name,
      slug: row.slug,
      isActive: row.id === session.activeOrg.id,
      roleLabel: capsById.get(row.id)?.label ?? "—",
      memberCount: await countRealMembers(row.id),
      shopifyStoreDomain: row.shopify_store_domain,
      whaapyBusinessId: row.whaapy_business_id,
      createdAt: row.created_at,
    });
  }
  return views.sort((a, b) => a.name.localeCompare(b.name, "es"));
}

export async function loadAdminOrganizations(): Promise<OrganizationsActionResult> {
  const res = await resolve();
  if (!res.ok) return res;
  return { ok: true, organizations: await buildView(res.session, res.authorized) };
}

const nameSchema = z
  .string()
  .trim()
  .min(2, "El nombre debe tener al menos 2 caracteres.")
  .max(80, "El nombre no puede pasar de 80 caracteres.");

const createSchema = z.object({
  name: nameSchema,
  /** Opcional: si no viene, se deriva del nombre. */
  slug: z.string().trim().max(ORG_SLUG_MAX_LENGTH).optional(),
});

/**
 * Crea una organización nueva con todos sus seeds y le cuelga la membresía
 * de quien la crea (rol admin), en UNA transacción SQL. Aparece de inmediato
 * en el selector del navbar — por eso se revalida el layout completo.
 */
export async function createOrganizationAction(
  raw: unknown,
): Promise<CreateOrganizationResult> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Datos inválidos." };
  }
  const res = await resolve();
  if (!res.ok) return res;

  const name = parsed.data.name;
  const slug = (parsed.data.slug?.trim() || deriveOrgSlug(name)).toLowerCase();
  const slugError = validateOrgSlug(slug);
  if (slugError) return { ok: false, message: slugError };

  if (await slugExists(slug)) {
    return {
      ok: false,
      message: `Ya existe una organización con el identificador "${slug}". Ajusta el nombre o el identificador.`,
    };
  }

  let orgId: UUID;
  try {
    orgId = await bootstrapOrganizationWithOwner({
      name,
      slug,
      ownerUserId: res.session.userId,
      ownerRole: "admin",
    });
  } catch (e) {
    // Carrera contra otra pestaña/otro admin: el UNIQUE de `slug` es la
    // guarda real; el chequeo de arriba solo mejora el mensaje.
    const message = e instanceof Error ? e.message : String(e);
    if (/duplicate key|unique/i.test(message)) {
      return {
        ok: false,
        message: `Ya existe una organización con el identificador "${slug}".`,
      };
    }
    return { ok: false, message: `No se pudo crear la organización: ${message}` };
  }

  // Audit en la org NUEVA: es donde vive el hecho ("así nació este tenant").
  await withTenantContext(
    orgId,
    () =>
      recordAuditEvent({
        actorUserId: res.session.userId,
        eventType: "organization_created",
        entityType: "organization",
        entityId: orgId,
        payload: { name, slug, created_from_organization_id: res.session.activeOrg.id },
      }),
    { source: "user_session" },
  );

  revalidatePath("/admin/organizaciones");
  revalidatePath("/", "layout");

  const session = await getSession();
  const authorized =
    session.status === "ok" ? await authorizedOrgs(session.data) : res.authorized;
  const sessionData = session.status === "ok" ? session.data : res.session;

  return {
    ok: true,
    organizations: await buildView(sessionData, authorized),
    created: { id: orgId, name, slug },
  };
}

const renameSchema = z.object({
  id: z.string().uuid(),
  name: nameSchema,
});

/**
 * Cambia el nombre VISIBLE de una organización. El `slug` no se toca: una
 * organización renombrada sigue resolviendo igual en el webhook de Whaapy
 * Post-venta y en los scripts. Ningún dato de negocio se mueve.
 */
export async function renameOrganizationAction(
  raw: unknown,
): Promise<OrganizationsActionResult> {
  const parsed = renameSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Datos inválidos." };
  }
  const res = await resolve();
  if (!res.ok) return res;

  const target = res.authorized.find((a) => a.org.id === parsed.data.id);
  if (!target) {
    // No filtra si la org existe o no: para este usuario, es lo mismo.
    return { ok: false, message: "No tienes permisos sobre esa organización." };
  }

  const previousName = target.org.name;
  const nextName = parsed.data.name;
  if (previousName === nextName) {
    return { ok: true, organizations: await buildView(res.session, res.authorized) };
  }

  await updateOrganization(target.org.id, { name: nextName });

  await withTenantContext(
    target.org.id,
    () =>
      recordAuditEvent({
        actorUserId: res.session.userId,
        eventType: "organization_renamed",
        entityType: "organization",
        entityId: target.org.id,
        payload: { previous_name: previousName, name: nextName, slug: target.org.slug },
      }),
    { source: "user_session" },
  );

  revalidatePath("/admin/organizaciones");
  revalidatePath("/", "layout");

  // La sesión cacheada trae el nombre viejo — releerla para que el listado
  // (y el "activa") refleje el cambio sin recargar a mano.
  const session = await getSession();
  const authorized =
    session.status === "ok" ? await authorizedOrgs(session.data) : res.authorized;
  const sessionData = session.status === "ok" ? session.data : res.session;

  return { ok: true, organizations: await buildView(sessionData, authorized) };
}
