"use client";
import { useState } from "react";
import {
  setWhaapyAgentIdAction,
  type AdvisorMappingRow as Row,
} from "@/lib/actions/admin-whaapy-agents";
import type { WhaapyAgent } from "@/lib/whaapy/team";

const MANUAL = "__manual__";

interface Props {
  advisor: Row;
  team: WhaapyAgent[] | null;
  onSaved: (advisors: Row[]) => void;
  onError: (message: string) => void;
}

/**
 * Fila del mapeo asesor ↔ agente Whaapy (Track 2). Muestra el mapeo actual y,
 * al editar, un selector con el equipo traído de Whaapy MÁS una opción de
 * captura manual del id (red por si el equipo no cargó o el agente no está en
 * la lista). Guardar vacío = des-mapear.
 */
export function AdvisorMappingRow({ advisor, team, onSaved, onError }: Props) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectVal, setSelectVal] = useState<string>("");
  const [manualVal, setManualVal] = useState<string>("");

  const teamAgent = team?.find((a) => a.id === advisor.whaapyAgentId) ?? null;
  const displayCurrent = advisor.whaapyAgentId
    ? teamAgent
      ? `${teamAgent.name ?? teamAgent.id}${teamAgent.email ? ` · ${teamAgent.email}` : ""}`
      : advisor.whaapyAgentId
    : null;

  function startEdit() {
    // Pre-selecciona el mapeo actual si está en el equipo; si no, manual.
    if (advisor.whaapyAgentId && team && team.some((a) => a.id === advisor.whaapyAgentId)) {
      setSelectVal(advisor.whaapyAgentId);
      setManualVal("");
    } else if (advisor.whaapyAgentId) {
      setSelectVal(MANUAL);
      setManualVal(advisor.whaapyAgentId);
    } else {
      setSelectVal("");
      setManualVal("");
    }
    setEditing(true);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    const hasTeam = team && team.length > 0;
    const chosen = hasTeam
      ? selectVal === MANUAL
        ? manualVal.trim()
        : selectVal
      : manualVal.trim();
    const res = await setWhaapyAgentIdAction({
      membershipId: advisor.membershipId,
      whaapyAgentId: chosen ? chosen : null,
    });
    setSaving(false);
    if (!res.ok) {
      onError(res.message);
      return;
    }
    setEditing(false);
    onSaved(res.advisors);
  }

  return (
    <li className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <span className="truncate">{advisor.name}</span>
            {!advisor.active && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                Inactivo
              </span>
            )}
          </p>
          <p className="text-xs mt-0.5 truncate">
            {displayCurrent ? (
              <span className="text-gray-600 dark:text-gray-300">
                Agente: <span className="font-mono">{displayCurrent}</span>
              </span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">Sin mapear</span>
            )}
          </p>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={startEdit}
            className="px-2 py-1 text-xs rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            {advisor.whaapyAgentId ? "Cambiar" : "Mapear"}
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-3 space-y-2 border-t border-gray-100 dark:border-gray-700 pt-3">
          {team && team.length > 0 && (
            <select
              value={selectVal}
              onChange={(e) => setSelectVal(e.target.value)}
              disabled={saving}
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100"
            >
              <option value="">Sin mapear</option>
              {team.map((a) => (
                <option key={a.id} value={a.id}>
                  {(a.name ?? a.id) + (a.email ? ` · ${a.email}` : "")}
                </option>
              ))}
              <option value={MANUAL}>— Capturar ID manualmente —</option>
            </select>
          )}

          {(!team || team.length === 0 || selectVal === MANUAL) && (
            <input
              type="text"
              value={manualVal}
              onChange={(e) => setManualVal(e.target.value)}
              placeholder="ID del agente en Whaapy"
              maxLength={200}
              disabled={saving}
              className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 text-sm px-2 py-1.5 text-gray-900 dark:text-gray-100 font-mono"
            />
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300"
            >
              {saving ? "Guardando..." : "Guardar"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
