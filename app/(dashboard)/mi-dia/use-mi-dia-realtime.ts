"use client";
import { useEffect, useRef, useState } from "react";
import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
} from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  PIPELINE_POLLING_FALLBACK_MS,
  PIPELINE_REALTIME_RECONNECT_TIMEOUT_MS,
} from "@/lib/constants";
import type { UUID } from "@/lib/types/database";

export type MiDiaRealtimeStatus = "connecting" | "connected" | "offline";

interface Args {
  organizationId: UUID;
  userId: UUID;
  /** Se invoca (coalescido) ante cualquier novedad: una regla generó
   *  una tarea/aviso, u otra sesión completó/pospuso algo. */
  onChange: () => void;
}

/**
 * Tiempo real de Mi Día (M1v2 — Bloque D). Suscribe `tasks` y
 * `notifications` del usuario activo, FILTRADO DEL LADO DEL SERVIDOR por
 * `organization_id` + `assigned_user_id`/`user_id` (no solo en cliente:
 * reduce tráfico y refuerza el aislamiento). Además re-valida la org en
 * el cliente como defensa multi-tenant.
 *
 * Misma disciplina que el realtime del pipeline (M5):
 *   - cleanup explícito al desmontar / cambiar de usuario;
 *   - stale timer → estado `offline` para el indicador sutil;
 *   - polling fallback SIEMPRE activo (camino feliz mientras el Auth
 *     Hook del claim `organization_id` no esté habilitado — ver CLAUDE.md
 *     "Hook de claim organization_id" y ERRORES.md). Cubre además cortes
 *     temporales y la entrega entre dispositivos.
 *
 * Los eventos no traen el modelo derivado de Mi Día, así que `onChange`
 * recarga el tablero completo (server action) en vez de mutar en sitio —
 * simple y siempre consistente.
 */
export function useMiDiaRealtime({ organizationId, userId, onChange }: Args): MiDiaRealtimeStatus {
  const [status, setStatus] = useState<MiDiaRealtimeStatus>("connecting");
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!organizationId || !userId) return;
    const supabase = getSupabaseBrowserClient();
    setStatus("connecting");

    // Coalescer ráfagas (varios eventos en cluster corto → un refresh).
    let coalesce: ReturnType<typeof setTimeout> | null = null;
    function notifyChange() {
      if (coalesce) clearTimeout(coalesce);
      coalesce = setTimeout(() => onChangeRef.current(), 250);
    }

    function isThisOrg(payload: RealtimePostgresChangesPayload<{ organization_id?: UUID }>): boolean {
      const row = (payload.new ?? payload.old ?? {}) as { organization_id?: UUID };
      return !row.organization_id || row.organization_id === organizationId;
    }

    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    function armStaleTimer() {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        setStatus((s) => (s === "connected" ? s : "offline"));
      }, PIPELINE_REALTIME_RECONNECT_TIMEOUT_MS);
    }
    armStaleTimer();

    const channel: RealtimeChannel = supabase
      .channel(`mi-dia:${organizationId}:${userId}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        {
          event: "*",
          schema: "public",
          table: "tasks",
          filter: `organization_id=eq.${organizationId},assigned_user_id=eq.${userId}`,
        },
        (payload: RealtimePostgresChangesPayload<{ organization_id?: UUID }>) => {
          if (isThisOrg(payload)) notifyChange();
        },
      )
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        {
          event: "*",
          schema: "public",
          table: "notifications",
          filter: `organization_id=eq.${organizationId},user_id=eq.${userId}`,
        },
        (payload: RealtimePostgresChangesPayload<{ organization_id?: UUID }>) => {
          if (isThisOrg(payload)) notifyChange();
        },
      )
      .subscribe((subStatus) => {
        if (subStatus === "SUBSCRIBED") {
          setStatus("connected");
          if (staleTimer) clearTimeout(staleTimer);
        } else if (
          subStatus === "CHANNEL_ERROR" ||
          subStatus === "TIMED_OUT" ||
          subStatus === "CLOSED"
        ) {
          setStatus("offline");
          armStaleTimer();
        }
      });

    // Polling fallback — red de seguridad SIEMPRE activa.
    const pollingInterval = setInterval(() => {
      onChangeRef.current();
    }, PIPELINE_POLLING_FALLBACK_MS);

    return () => {
      if (coalesce) clearTimeout(coalesce);
      if (staleTimer) clearTimeout(staleTimer);
      clearInterval(pollingInterval);
      supabase.removeChannel(channel);
    };
  }, [organizationId, userId]);

  return status;
}
