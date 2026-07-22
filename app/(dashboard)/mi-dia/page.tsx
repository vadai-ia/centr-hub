import { loadMiDiaAction } from "@/lib/actions/mi-dia";
import { loadMiDiaAdminExtrasAction } from "@/lib/actions/mi-dia-admin";
import { loadMyGoalProgress } from "@/lib/actions/dashboard-goals";
import { getSession } from "@/lib/auth/session";
import { canSeeAllData, fallbackCapabilities } from "@/lib/auth/capabilities";
import type { MiDiaAdminExtras } from "@/lib/services/mi-dia-admin";
import type { VendorGoalProgress } from "@/lib/services/goal-progress";
import { MiDiaScreen } from "./mi-dia-screen";

// M1v2 — Bloques B + C + D. Mi Día: el vendedor concentra su trabajo del
// día; el admin además tiene toggle Mis pendientes / Vista equipo y las
// oportunidades sin asignar. Server Component que pre-carga todo y delega
// la interacción + Realtime al client component.
export default async function MiDiaPage() {
  const [res, session] = await Promise.all([loadMiDiaAction(), getSession()]);
  if (!res.ok) {
    return (
      <div className="p-6">
        <p className="text-sm text-red-600 dark:text-red-400">{res.message}</p>
      </div>
    );
  }
  const ok = session.status === "ok";
  const organizationId = ok ? session.data.activeOrg.id : "";
  const userId = ok ? session.data.userId : "";
  // "Vista de equipo" (todos los asesores) para roles que alcanzan todos
  // los datos (admin/superadmin/SDR); vista propia para vendedor (0039).
  const caps = ok ? session.data.activeRole : fallbackCapabilities("vendedor");
  const isAdmin = canSeeAllData(caps);

  let adminExtras: MiDiaAdminExtras | null = null;
  if (isAdmin) {
    const ex = await loadMiDiaAdminExtrasAction();
    if (ex.ok) adminExtras = ex.extras;
  }

  // El widget "Meta del mes" es solo para vendedores (un admin no es titular
  // de metas — ve equipo/vendedores en el Dashboard). No cargamos su avance.
  let goal: VendorGoalProgress | null = null;
  if (!isAdmin) {
    const goalRes = await loadMyGoalProgress();
    goal = goalRes.ok ? goalRes.data : null;
  }

  return (
    <MiDiaScreen
      initialData={res.data}
      organizationId={organizationId}
      userId={userId}
      isAdmin={isAdmin}
      initialAdminExtras={adminExtras}
      goal={goal}
    />
  );
}
