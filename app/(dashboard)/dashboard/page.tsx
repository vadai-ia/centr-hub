import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { loadDashboardAction } from "@/lib/actions/dashboard";
import { DEFAULT_DASHBOARD_FILTERS } from "@/lib/actions/dashboard-defaults";
import { DashboardScreen } from "./dashboard-screen";
import { DashboardErrorScreen } from "./dashboard-error-screen";

/**
 * Dashboard descriptivo (M8.2) — reemplaza el placeholder de M2.
 *
 * Server Component: carga el snapshot inicial con los filtros default
 * (Funnel Venta, últimos 30 días, toda la org si admin) vía la server
 * action `loadDashboardAction`, y delega toda la interactividad
 * (filtros, gráficas, export) al client `DashboardScreen`. NO hay
 * polling — el dashboard es pull bajo demanda (deuda M5-DT-03: no
 * reintroducir refresco pesado).
 */
export default async function DashboardPage() {
  const session = await getSession();
  if (session.status !== "ok") {
    redirect("/login");
  }

  const initial = await loadDashboardAction(DEFAULT_DASHBOARD_FILTERS);
  if (!initial.ok) {
    return <DashboardErrorScreen message={initial.message} />;
  }

  return (
    <DashboardScreen
      // Remonta al cambiar de org (mismo patrón que el pipeline M5).
      key={session.data.activeOrg.id}
      initial={initial}
      orgName={session.data.activeOrg.name}
    />
  );
}
