import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { canSeeAllData } from "@/lib/auth/capabilities";
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

  const isAdmin = canSeeAllData(session.data.activeRole);

  const [rawFunnel, unassignedRaw] = await Promise.all([
    readFunnelPreference(),
    readUnassignedFilterPreference(),
  ]);
  // El funnel Outbound solo es visible para roles con data_scope='all'. Si
  // un vendedor tuviera una cookie 'outbound' (heredada al cambiar de rol),
  // se coacciona a 'venta' para no aterrizar en la pantalla de error.
  const funnel = rawFunnel === "outbound" && !isAdmin ? "venta" : rawFunnel;
  const unassignedFilter = isAdmin && unassignedRaw;

  const initial = await loadInitialPipelineState({ funnel, unassignedFilter });
  if (!initial.ok) {
    return <PipelineErrorScreen reason={initial.reason} />;
  }

  return (
    <PipelineBoard
      // El `key` por org activa fuerza unmount + remount del board
      // cuando el operador cambia de organización vía OrgSelector
      // (que llama switchOrganization + router.refresh). Sin esto,
      // el client component retiene el estado (cards, stages, filtros)
      // de la org anterior aunque el server haya re-renderizado este
      // page con el snapshot nuevo — el usuario ve datos obsoletos
      // hasta navegar a otra ruta y volver. El backend ya bloquea
      // cualquier move cross-tenant (RLS + optimistic lock), pero
      // la UI debe reflejar la org activa de inmediato.
      key={session.data.activeOrg.id}
      initial={initial.state}
      canSeeAll={isAdmin}
      userId={session.data.userId}
      organizationId={session.data.activeOrg.id}
      unassignedFilter={unassignedFilter}
    />
  );
}
