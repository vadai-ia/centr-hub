import { requireTabOrRedirect } from "@/lib/auth/require-tab";
import { loadAdminRules } from "@/lib/actions/admin-rules";
import { ReglasScreen } from "./reglas-screen";

// M1v2 — Bloque A3. Motor de Reglas: el admin crea/edita/elimina reglas
// de automatización y activa/desactiva las preconfiguradas. Server
// Component que pre-carga reglas + etapas y delega la interacción al
// client component.
export default async function ReglasPage() {
  await requireTabOrRedirect("admin-reglas");
  const res = await loadAdminRules();
  if (!res.ok) {
    return (
      <div className="p-6">
        <p className="text-sm text-red-600 dark:text-red-400">{res.message}</p>
      </div>
    );
  }
  return <ReglasScreen initialRules={res.rules} stages={res.stages} />;
}
