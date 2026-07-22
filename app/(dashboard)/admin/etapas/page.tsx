import { requireTabOrRedirect } from "@/lib/auth/require-tab";
import { loadAdminStages } from "@/lib/actions/admin-stages";
import { EtapasScreen } from "./etapas-screen";

/**
 * Admin → Etapas del pipeline (M7.2, Bloque 3). El guard de rol vive
 * en el layout de admin; `loadAdminStages` revalida sesión + rol.
 */
export default async function EtapasPage() {
  await requireTabOrRedirect("admin-etapas");
  const res = await loadAdminStages();
  if (!res.ok) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center text-gray-500 dark:text-gray-400">
        <p>{res.message}</p>
      </div>
    );
  }
  return <EtapasScreen initialVenta={res.venta} initialPostVenta={res.postVenta} />;
}
