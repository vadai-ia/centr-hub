"use client";
import { useState } from "react";
import type { AdvisorMappingRow as Row } from "@/lib/actions/admin-whaapy-agents";
import type { WhaapyAgent } from "@/lib/whaapy/team";
import { AdvisorMappingRow } from "./advisor-mapping-row";

interface Props {
  initialAdvisors: Row[];
  team: WhaapyAgent[] | null;
  teamError: string | null;
}

/**
 * Admin → Agentes Whaapy (Track 2 / Bloque C). Mapea cada vendedor a su agente
 * del Whaapy de Venta. Poblar este mapeo es lo que habilita que la asignación
 * fluya en ambos sentidos (inbound `conversation.assigned` y outbound
 * `assigned_agent_id`).
 */
export function AgentesWhaapyScreen({ initialAdvisors, team, teamError }: Props) {
  const [advisors, setAdvisors] = useState(initialAdvisors);
  const [banner, setBanner] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  const mapped = advisors.filter((a) => a.whaapyAgentId).length;

  return (
    <div className="max-w-2xl mx-auto">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Agentes Whaapy</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          Vincula cada vendedor con su agente del Whaapy de Venta. Sin este mapeo, la asignación
          de conversaciones no se refleja entre la plataforma y Whaapy.
        </p>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 tabular-nums">
          {mapped} de {advisors.length} mapeados
        </p>
      </header>

      {teamError && (
        <div
          role="alert"
          className="mb-3 px-3 py-2 rounded-md bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200 text-sm"
        >
          {teamError}
        </div>
      )}

      {banner && (
        <div
          role={banner.tone === "error" ? "alert" : "status"}
          className={`mb-3 px-3 py-2 rounded-md text-sm flex items-center justify-between gap-3 ${
            banner.tone === "error"
              ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300"
              : "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"
          }`}
        >
          <span>{banner.text}</span>
          <button type="button" onClick={() => setBanner(null)} className="text-xs underline opacity-80 hover:opacity-100">
            cerrar
          </button>
        </div>
      )}

      {advisors.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center">
          No hay vendedores para mapear.
        </p>
      ) : (
        <ul className="space-y-2">
          {advisors.map((a) => (
            <AdvisorMappingRow
              key={a.membershipId}
              advisor={a}
              team={team}
              onSaved={(next) => {
                setAdvisors(next);
                setBanner({ tone: "success", text: "Mapeo actualizado." });
              }}
              onError={(m) => setBanner({ tone: "error", text: m })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
