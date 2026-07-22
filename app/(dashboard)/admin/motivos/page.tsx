import { requireTabOrRedirect } from "@/lib/auth/require-tab";
import { loadAdminLossReasons } from "@/lib/actions/admin-loss-reasons";
import { MotivosScreen } from "./motivos-screen";

/**
 * Admin → Motivos de pérdida (M7.2, Bloque 4).
 */
export default async function MotivosPage() {
  await requireTabOrRedirect("admin-motivos");
  const res = await loadAdminLossReasons();
  if (!res.ok) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center text-gray-500 dark:text-gray-400">
        <p>{res.message}</p>
      </div>
    );
  }
  return <MotivosScreen initialReasons={res.reasons} />;
}
