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
import type { Funnel, UUID } from "@/lib/types/database";

export type RealtimeStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "stale";

interface Args {
  organizationId: UUID;
  funnel: Funnel;
  /**
   * - undefined → admin sin filtro (recibe todas las opps del funnel
   *   en la org).
   * - null → admin con filtro "Sin asignar" (Supabase Realtime no
   *   soporta filtro `is null`; manejamos el case con post-filtro JS).
   * - UUID → vendedor (su membership) o admin filtrando por advisor.
   */
  effectiveAdvisorId: UUID | null | undefined;
  /**
   * Callback que recibe cada evento Realtime. El consumer decide qué
   * hacer (refrescar la opp, mover entre columnas, etc.).
   *
   * NOTA OPERATIVA: para que estos eventos se entreguen al browser,
   * Supabase RLS debe permitir al user SELECT sobre la fila. En el
   * stack actual (M5), `current_organization_id()` resuelve sólo
   * desde un setting de sesión o JWT claim — ninguno de los dos está
   * presente en sesiones de navegador. Por eso M5 confía en el
   * polling fallback como camino feliz hasta que se configure el
   * Auth Hook que inyecta el claim. Ver ERRORES.md "Realtime sin JWT
   * claim org_id" y PENDIENTES.md.
   */
  onEvent: (
    payload: RealtimePostgresChangesPayload<{
      id: UUID;
      organization_id: UUID;
      funnel: Funnel;
      assigned_advisor_id: UUID | null;
    }>,
  ) => void;
  /** Disparado en cada tick del fallback polling. */
  onPollingTick: () => void;
}

/**
 * Hook que monta la suscripción Realtime + un polling fallback al
 * mismo tiempo.
 *
 * Garantías que cumple este hook (prompt M5 "Restricciones técnicas
 * no-obvias"):
 *   - Filtro por organización + funnel en cada subscripción (defensa
 *     multi-tenant adicional a la RLS).
 *   - Cleanup explícito al desmontar y al cambiar el filtro
 *     (funnel/advisor) — evita acumular canales huérfanos.
 *   - Reintento automático con backoff. Tras `PIPELINE_REALTIME_RECONNECT_TIMEOUT_MS`
 *     sin éxito, marca estado `stale` para que el toolbar invite al
 *     reload manual.
 *   - Polling fallback cada `PIPELINE_POLLING_FALLBACK_MS` para
 *     compensar tanto la falta de RLS hook como cortes temporales.
 */
export function usePipelineRealtime({
  organizationId,
  funnel,
  effectiveAdvisorId,
  onEvent,
  onPollingTick,
}: Args): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const onEventRef = useRef(onEvent);
  const onPollingTickRef = useRef(onPollingTick);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);
  useEffect(() => {
    onPollingTickRef.current = onPollingTick;
  }, [onPollingTick]);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    setStatus("connecting");

    // Filtro server-side. Supabase Realtime acepta una sola cláusula
    // `filter`, así que combinamos `organization_id=eq.X AND funnel=eq.Y`.
    // Si hay advisor concreto (vendedor o admin filtrando por advisor),
    // lo incluimos. El caso "null" (admin "Sin asignar") no lo
    // filtramos server-side — el consumer hace post-filtro y descarta
    // eventos cuyo `assigned_advisor_id !== null`.
    const filterParts = [
      `organization_id=eq.${organizationId}`,
      `funnel=eq.${funnel}`,
    ];
    if (effectiveAdvisorId !== undefined && effectiveAdvisorId !== null) {
      filterParts.push(`assigned_advisor_id=eq.${effectiveAdvisorId}`);
    }
    const channelName = `pipeline:${organizationId}:${funnel}:${effectiveAdvisorId ?? "all"}`;
    const filter = filterParts.join(",");

    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    function armStaleTimer() {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        setStatus((s) => (s === "connected" ? s : "stale"));
      }, PIPELINE_REALTIME_RECONNECT_TIMEOUT_MS);
    }
    armStaleTimer();

    const channel: RealtimeChannel = supabase
      .channel(channelName)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        {
          event: "*",
          schema: "public",
          table: "opportunities",
          filter,
        },
        (
          payload: RealtimePostgresChangesPayload<{
            id: UUID;
            organization_id: UUID;
            funnel: Funnel;
            assigned_advisor_id: UUID | null;
          }>,
        ) => {
          // Defensa multi-tenant: aunque el filtro server-side ya
          // restringe, validamos en cliente — un bug en el filtro o
          // un payload anómalo no debe filtrar org cross.
          const newRow = (payload.new ?? {}) as {
            organization_id?: UUID;
            funnel?: Funnel;
          };
          if (newRow.organization_id && newRow.organization_id !== organizationId) {
            return;
          }
          if (newRow.funnel && newRow.funnel !== funnel) return;

          // Post-filtro para admin "Sin asignar"
          if (effectiveAdvisorId === null) {
            const advisor = (payload.new ?? payload.old ?? {}) as {
              assigned_advisor_id?: UUID | null;
            };
            if (advisor.assigned_advisor_id !== null) return;
          }

          onEventRef.current(payload);
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
          setStatus("disconnected");
          armStaleTimer();
        }
      });

    const pollingInterval = setInterval(() => {
      onPollingTickRef.current();
    }, PIPELINE_POLLING_FALLBACK_MS);

    return () => {
      if (staleTimer) clearTimeout(staleTimer);
      clearInterval(pollingInterval);
      supabase.removeChannel(channel);
    };
  }, [organizationId, funnel, effectiveAdvisorId]);

  return status;
}
