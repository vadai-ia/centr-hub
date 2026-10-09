"use client";
import { useEffect, useRef } from "react";
import { presenceHeartbeatAction } from "@/lib/actions/presence";
import { PRESENCE_HEARTBEAT_MS } from "@/lib/constants";

/**
 * Latido de presencia (0057). No pinta nada — vive en el layout autenticado
 * para que cualquier pantalla de la plataforma cuente como "está usándola".
 *
 * Solo late con la pestaña VISIBLE. Una pestaña olvidada en segundo plano
 * durante el fin de semana reportaría a alguien "conectado" sin estarlo, que
 * es justo lo contrario de lo que se quiere saber. Al volver a la pestaña
 * late de inmediato, sin esperar el siguiente intervalo.
 */
export function PresenceHeartbeat() {
  const lastPingRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    // El throttle no es paranoia: `visibilitychange` dispara al alternar
    // entre pestañas, y sin él un ida y vuelta rápido manda un latido por
    // cada cambio de foco.
    const minGapMs = PRESENCE_HEARTBEAT_MS / 4;

    const ping = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) return;
      const now = Date.now();
      if (now - lastPingRef.current < minGapMs) return;
      lastPingRef.current = now;
      void presenceHeartbeatAction();
    };

    ping();
    const timer = window.setInterval(ping, PRESENCE_HEARTBEAT_MS);
    document.addEventListener("visibilitychange", ping);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", ping);
    };
  }, []);

  return null;
}
