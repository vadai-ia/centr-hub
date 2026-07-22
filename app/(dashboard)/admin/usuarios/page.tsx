import { requireTabOrRedirect } from "@/lib/auth/require-tab";
import { loadAdminUsers } from "@/lib/actions/admin-users";
import { UsuariosScreen } from "./usuarios-screen";

/**
 * Admin → Usuarios (M9.2). El guard de rol vive en el layout de admin;
 * `loadAdminUsers` revalida sesión + rol. "Histórico" no se lista (R10).
 */
export default async function UsuariosPage() {
  await requireTabOrRedirect("admin-usuarios");
  const res = await loadAdminUsers();
  if (!res.ok) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center text-gray-500 dark:text-gray-400">
        <p>{res.message}</p>
      </div>
    );
  }
  return (
    <UsuariosScreen
      initialUsers={res.users}
      assignableRoles={res.assignableRoles}
    />
  );
}
