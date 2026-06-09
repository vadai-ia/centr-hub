"use client";
import { useEffect, useState, useTransition } from "react";
import {
  setActiveFunnelPreference,
  setUnassignedFilterPreference,
} from "@/lib/actions/pipeline";
import { HIDE_CLOSED_DAYS_MAX, HIDE_CLOSED_DAYS_MIN } from "@/lib/constants";
import type { Funnel, Role } from "@/lib/types/database";

interface Props {
  funnel: Funnel;
  role: Role;
  unassignedFilter: boolean;
  realtimeStatus: "connected" | "connecting" | "disconnected" | "stale";
  /** Umbral global vigente (días) de auto-ocultar cerradas. */
  hideClosedAfterDays: number;
  onFunnelChange: (f: Funnel) => void;
  onUnassignedToggle: (enabled: boolean) => void;
  /** Persiste el umbral (solo admin). */
  onHideClosedDaysChange: (days: number) => void | Promise<void>;
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
  hideClosedAfterDays,
  onFunnelChange,
  onUnassignedToggle,
  onHideClosedDaysChange,
}: Props) {
  const [isPending, startTransition] = useTransition();
  const isAdmin = role === "admin" || role === "superadmin";

  // Draft local del umbral — se aplica al blur/Enter, no por tecla, para
  // no recargar el tablero en cada dígito.
  const [daysDraft, setDaysDraft] = useState<string>(String(hideClosedAfterDays));
  useEffect(() => {
    setDaysDraft(String(hideClosedAfterDays));
  }, [hideClosedAfterDays]);

  function commitDays() {
    const parsed = Number(daysDraft);
    if (!Number.isFinite(parsed)) {
      setDaysDraft(String(hideClosedAfterDays));
      return;
    }
    const clamped = Math.min(
      HIDE_CLOSED_DAYS_MAX,
      Math.max(HIDE_CLOSED_DAYS_MIN, Math.floor(parsed)),
    );
    if (clamped === hideClosedAfterDays) {
      setDaysDraft(String(clamped));
      return;
    }
    void onHideClosedDaysChange(clamped);
  }

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
    <div className="flex flex-wrap items-center gap-2 mb-2 pb-2 border-b border-gray-200 dark:border-gray-700">
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

      {isAdmin && (
        <label
          className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 select-none"
          title="Las oportunidades Ganadas y Perdidas se ocultan del tablero tras estos días desde su cierre. Es solo visualización: no se borran ni afectan los indicadores."
        >
          <span className="hidden sm:inline">Ocultar cerradas tras</span>
          <span className="sm:hidden">Ocultar tras</span>
          <input
            type="number"
            inputMode="numeric"
            min={HIDE_CLOSED_DAYS_MIN}
            max={HIDE_CLOSED_DAYS_MAX}
            value={daysDraft}
            onChange={(e) => setDaysDraft(e.target.value)}
            onBlur={commitDays}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            className="w-14 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-1.5 py-0.5 text-center tabular-nums text-gray-700 dark:text-gray-200"
            aria-label="Días para ocultar oportunidades cerradas"
          />
          <span>días</span>
        </label>
      )}

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
