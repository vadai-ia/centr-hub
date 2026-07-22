import { requireTabOrRedirect } from "@/lib/auth/require-tab";
import { loadAdminRoles } from "@/lib/actions/admin-roles";
import { RolesScreen } from "./roles-screen";

/**
 * Admin → Roles y permisos (0039). El gate de entrada vive en el layout de
 * admin; `loadAdminRoles` revalida sesión + pestaña `admin-roles`.
 */
export default async function RolesPage() {
  await requireTabOrRedirect("admin-roles");
  const res = await loadAdminRoles();
  if (!res.ok) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center text-gray-500 dark:text-gray-400">
        <p>{res.message}</p>
      </div>
    );
  }
  return <RolesScreen initialRoles={res.roles} />;
}
