import { loadWhaapyAgentMapping } from "@/lib/actions/admin-whaapy-agents";
import { AgentesWhaapyScreen } from "./agentes-whaapy-screen";

/**
 * Admin → Agentes Whaapy (Track 2 / Bloque C). Mapea cada vendedor a su agente
 * del Whaapy de Venta (`memberships.whaapy_agent_id`), habilitando la
 * asignación bidireccional.
 */
export default async function AgentesWhaapyPage() {
  const res = await loadWhaapyAgentMapping();
  if (!res.ok) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center text-gray-500 dark:text-gray-400">
        <p>{res.message}</p>
      </div>
    );
  }
  return (
    <AgentesWhaapyScreen
      initialAdvisors={res.advisors}
      team={res.team}
      teamError={res.teamError}
    />
  );
}
