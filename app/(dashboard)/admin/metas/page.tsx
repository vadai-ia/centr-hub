import { loadAdminMetas } from "@/lib/actions/admin-metas";
import { MetasScreen } from "./metas-screen";

/**
 * Admin → Metas (M2v2 — Bloque 3). El guard de rol vive en el layout de
 * admin; `loadAdminMetas` revalida sesión + rol y carga metas, umbrales y
 * el histórico mensual.
 */
export default async function MetasPage() {
  const res = await loadAdminMetas();
  if (!res.ok) {
    return (
      <div className="mx-auto max-w-4xl py-16 text-center text-slate-500 dark:text-slate-400">
        <p>{res.message}</p>
      </div>
    );
  }
  return <MetasScreen initialData={res.data} />;
}
