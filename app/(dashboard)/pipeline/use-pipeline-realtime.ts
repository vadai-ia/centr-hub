"use client";
import { useEffect, useRef, useState } from "react";
import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
} from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  PIPELINE_REALTIME_RECONNECT_TIMEOUT_MS,
  REALTIME_BURST_WINDOW_MS,
} from "@/lib/constants";
import { useBackgroundRefresh, isDocumentHidden } from "@/lib/realtime/use-background-refresh";
import { planBurstFlush } from "@/lib/services/realtime-refresh-policy";
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
  /**
   * Recarga COMPLETA del tablero. La dispara la recarga de fondo adaptativa
   * (ver `shouldBackgroundRefresh`) y una ráfaga grande de cambios.
   */
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
 *   - Recarga de fondo ADAPTATIVA (`useBackgroundRefresh`): nada con la
 *     pestaña oculta; cada 30 s si Realtime cayó; cada 5 min de respaldo si
 *     está conectado. Antes era cada 30 s incondicional y agotó el CPU de
 *     Vercel (proyecto pausado).
 *   - Pestaña oculta: los eventos NO llaman al servidor; dejan pendiente
 *     una recarga para cuando vuelva.
 *   - Ráfagas: los cambios se juntan `REALTIME_BURST_WINDOW_MS`; con muchas
 *     tarjetas, una recarga completa en vez de N lecturas sueltas.
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
  const connectedRef = useRef(false);
  const { markDirty, markRefreshed } = useBackgroundRefresh(
    () => onPollingTickRef.current(),
    connectedRef,
  );

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);
  useEffect(() => {
    onPollingTickRef.current = onPollingTick;
  }, [onPollingTick]);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    setStatus("connecting");
    connectedRef.current = false;

    // Ráfaga en curso: último payload por opp (una opp que cambia 3 veces
    // en un segundo se lee UNA vez).
    type Payload = Parameters<Args["onEvent"]>[0];
    const pending = new Map<UUID, Payload>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    function flush() {
      flushTimer = null;
      const batch = Array.from(pending.values());
      pending.clear();
      const plan = planBurstFlush(batch.length);
      if (plan === "full_reload") {
        markRefreshed();
        onPollingTickRef.current();
      } else if (plan === "per_item") {
        for (const p of batch) onEventRef.current(p);
      }
    }
    function enqueue(payload: Payload) {
      // Un borrado se aplica en local, sin servidor: no se junta.
      if (payload.eventType === "DELETE") {
        onEventRef.current(payload);
        return;
      }
      // Nadie mira la pestaña: no se paga ninguna lectura. Al volver, una
      // sola recarga completa la pone al día.
      if (isDocumentHidden()) {
        markDirty();
        return;
      }
      const id = ((payload.new ?? payload.old) as { id?: UUID })?.id;
      if (!id) return;
      pending.set(id, payload);
      if (!flushTimer) flushTimer = setTimeout(flush, REALTIME_BURST_WINDOW_MS);
    }

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

          enqueue(payload);
        },
      )
      .subscribe((subStatus) => {
        if (subStatus === "SUBSCRIBED") {
          connectedRef.current = true;
          setStatus("connected");
          if (staleTimer) clearTimeout(staleTimer);
        } else if (
          subStatus === "CHANNEL_ERROR" ||
          subStatus === "TIMED_OUT" ||
          subStatus === "CLOSED"
        ) {
          connectedRef.current = false;
          setStatus("disconnected");
          armStaleTimer();
        }
      });

    return () => {
      if (staleTimer) clearTimeout(staleTimer);
      if (flushTimer) clearTimeout(flushTimer);
      pending.clear();
      connectedRef.current = false;
      supabase.removeChannel(channel);
    };
  }, [organizationId, funnel, effectiveAdvisorId, markDirty, markRefreshed]);

  return status;
}
