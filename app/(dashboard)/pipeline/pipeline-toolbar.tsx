"use client";
import { useTransition } from "react";
import {
  setActiveFunnelPreference,
  setUnassignedFilterPreference,
} from "@/lib/actions/pipeline";
import type { Funnel, Role } from "@/lib/types/database";

interface Props {
  funnel: Funnel;
  role: Role;
  unassignedFilter: boolean;
  realtimeStatus: "connected" | "connecting" | "disconnected" | "stale";
  onFunnelChange: (f: Funnel) => void;
  onUnassignedToggle: (enabled: boolean) => void;
}

/**
 * Toolbar superior del pipeline (M5).
 *
 * - Toggle Venta / Post-venta (persistido por usuario).
 * - Filtro admin "Sin asignar" (visible solo si role admin/superadmin).
 * - Indicador de conexión Realtime (sugiere reload si está stale).
 *
 * El toggle re-establece la suscripción Realtime y dispara el carga
 * del funnel nuevo en el padre (`onFunnelChange`).
 */
export function PipelineToolbar({
  funnel,
  role,
  unassignedFilter,
  realtimeStatus,
  onFunnelChange,
  onUnassignedToggle,
}: Props) {
  const [isPending, startTransition] = useTransition();
  const isAdmin = role === "admin" || role === "superadmin";

  function selectFunnel(next: Funnel) {
    if (next === funnel) return;
    onFunnelChange(next);
    startTransition(async () => {
      await setActiveFunnelPreference(next);
    });
  }

  function selectUnassigned(next: boolean) {
    onUnassignedToggle(next);
    startTransition(async () => {
      await setUnassignedFilterPreference(next);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 mb-4 pb-3 border-b border-gray-200 dark:border-gray-700">
      <div
        role="tablist"
        aria-label="Funnel activo"
        className="inline-flex rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-0.5"
      >
        <FunnelTab
          label="Venta"
          isActive={funnel === "venta"}
          onClick={() => selectFunnel("venta")}
          disabled={isPending && funnel !== "venta"}
        />
        <FunnelTab
          label="Post-venta"
          isActive={funnel === "post_venta"}
          onClick={() => selectFunnel("post_venta")}
          disabled={isPending && funnel !== "post_venta"}
        />
      </div>

      {isAdmin && (
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 select-none cursor-pointer">
          <input
            type="checkbox"
            checked={unassignedFilter}
            onChange={(e) => selectUnassigned(e.target.checked)}
            className="rounded border-gray-300 dark:border-gray-600"
          />
          Solo sin asignar
        </label>
      )}

      <div className="flex-1" />

      <RealtimeIndicator status={realtimeStatus} />
    </div>
  );
}

function FunnelTab({
  label,
  isActive,
  onClick,
  disabled,
}: {
  label: string;
  isActive: boolean;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      disabled={disabled}
      onClick={onClick}
      className={[
        "px-3 py-1 text-sm rounded transition-colors",
        isActive
          ? "bg-indigo-600 text-white"
          : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700",
        disabled ? "opacity-60 cursor-not-allowed" : "",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function RealtimeIndicator({
  status,
}: {
  status: "connected" | "connecting" | "disconnected" | "stale";
}) {
  const config = {
    connected: { dot: "bg-emerald-500", label: "En vivo", title: "Recibiendo actualizaciones en tiempo real" },
    connecting: { dot: "bg-amber-400 animate-pulse", label: "Conectando", title: "Estableciendo conexión en vivo" },
    disconnected: { dot: "bg-rose-500", label: "Reintentando", title: "Sin conexión en vivo — reintentando automáticamente" },
    stale: { dot: "bg-rose-500", label: "Recarga la página", title: "La conexión en vivo no se restauró. Recarga para ver cambios recientes." },
  }[status];

  return (
    <div
      className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400"
      title={config.title}
      aria-live="polite"
    >
      <span
        className={`inline-block w-2 h-2 rounded-full ${config.dot}`}
        aria-hidden
      />
      <span>{config.label}</span>
    </div>
  );
}
