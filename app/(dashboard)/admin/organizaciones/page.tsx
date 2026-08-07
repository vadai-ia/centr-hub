import { requireTabOrRedirect } from "@/lib/auth/require-tab";
import { loadAdminOrganizations } from "@/lib/actions/admin-organizations";
import { OrganizationsScreen } from "./organizations-screen";

/**
 * Admin → Organizaciones (0048). El gate grueso vive en el layout de admin;
 * `loadAdminOrganizations` revalida sesión + pestaña `admin-organizaciones`
 * y además filtra por-organización (solo las que el usuario administra).
 */
export default async function OrganizacionesPage() {
  await requireTabOrRedirect("admin-organizaciones");
  const res = await loadAdminOrganizations();
  if (!res.ok) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center text-gray-500 dark:text-gray-400">
        <p>{res.message}</p>
      </div>
    );
  }
  return <OrganizationsScreen initialOrganizations={res.organizations} />;
}
