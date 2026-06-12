import { loadMiDiaAction } from "@/lib/actions/mi-dia";
import { loadMiDiaAdminExtrasAction } from "@/lib/actions/mi-dia-admin";
import { getSession } from "@/lib/auth/session";
import type { MiDiaAdminExtras } from "@/lib/services/mi-dia-admin";
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
  const role = ok ? session.data.activeOrg.role : "vendedor";
  const isAdmin = role === "admin" || role === "superadmin";

  let adminExtras: MiDiaAdminExtras | null = null;
  if (isAdmin) {
    const ex = await loadMiDiaAdminExtrasAction();
    if (ex.ok) adminExtras = ex.extras;
  }

  return (
    <MiDiaScreen
      initialData={res.data}
      organizationId={organizationId}
      userId={userId}
      isAdmin={isAdmin}
      initialAdminExtras={adminExtras}
    />
  );
}
