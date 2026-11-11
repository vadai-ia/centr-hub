"use client";
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { REALTIME_POLL_CHECK_MS } from "@/lib/constants";
import { shouldBackgroundRefresh, type RefreshTrigger } from "@/lib/services/realtime-refresh-policy";

/**
 * Recarga de fondo de un tablero con Realtime. La DECISIÓN vive en
 * `shouldBackgroundRefresh` (puro, testeado); esto solo la cablea a los
 * relojes y a `visibilitychange`.
 *
 * El tick es frecuente y barato: solo evalúa la regla. Lo caro (la server
 * action) ocurre únicamente cuando la regla dice que toca.
 */
export function useBackgroundRefresh(
  onRefresh: () => void,
  connectedRef: MutableRefObject<boolean>,
): { markDirty: () => void; markRefreshed: () => void } {
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  // El estado inicial lo trajo el servidor al montar: cuenta como recarga.
  const lastRefreshAt = useRef(Date.now());
  const dirty = useRef(false);

  const markRefreshed = useCallback(() => {
    lastRefreshAt.current = Date.now();
    dirty.current = false;
  }, []);
  const markDirty = useCallback(() => {
    dirty.current = true;
  }, []);

  useEffect(() => {
    const evaluate = (trigger: RefreshTrigger) => {
      const go = shouldBackgroundRefresh(trigger, {
        hidden: typeof document !== "undefined" && document.hidden,
        connected: connectedRef.current,
        msSinceLastRefresh: Date.now() - lastRefreshAt.current,
        dirty: dirty.current,
      });
      if (!go) return;
      lastRefreshAt.current = Date.now();
      dirty.current = false;
      onRefreshRef.current();
    };
    const onTick = () => evaluate("tick");
    const onVisibility = () => evaluate("visible");
    const timer = window.setInterval(onTick, REALTIME_POLL_CHECK_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [connectedRef]);

  return { markDirty, markRefreshed };
}

export function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}
