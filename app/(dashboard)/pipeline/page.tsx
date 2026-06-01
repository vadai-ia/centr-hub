import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import {
  loadInitialPipelineState,
  readFunnelPreference,
  readUnassignedFilterPreference,
} from "@/lib/actions/pipeline";
import { PipelineBoard } from "./pipeline-board";
import { PipelineErrorScreen } from "./pipeline-error-screen";

/**
 * Pipeline kanban dual (M5).
 *
 * Server Component que carga el snapshot inicial vía
 * `loadInitialPipelineState` (Server Action — corre en proceso),
 * y delega toda la interactividad (drag-drop, Realtime, modales) al
 * client component `PipelineBoard`.
 *
 * El layout `dashboard/layout.tsx` ya resolvió la sesión y muestra
 * Navbar + Sidebar; este page solo entrega el contenido.
 */
export default async function PipelinePage() {
  const session = await getSession();
  if (session.status !== "ok") {
    // Defensa: el layout ya redirige no-auth y no-membership, pero
    // re-validamos por si esta page se renderiza por otro path.
    redirect("/login");
  }

  const role = session.data.activeOrg.role;
  const isAdmin = role === "admin" || role === "superadmin";

  const [funnel, unassignedRaw] = await Promise.all([
    readFunnelPreference(),
    readUnassignedFilterPreference(),
  ]);
  const unassignedFilter = isAdmin && unassignedRaw;

  const initial = await loadInitialPipelineState({ funnel, unassignedFilter });
  if (!initial.ok) {
    return <PipelineErrorScreen reason={initial.reason} />;
  }

  return (
    <PipelineBoard
      initial={initial.state}
      role={role}
      userId={session.data.userId}
      organizationId={session.data.activeOrg.id}
      unassignedFilter={unassignedFilter}
    />
  );
}
