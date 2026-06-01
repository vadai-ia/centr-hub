"use client";
import { useCallback, useRef, useState } from "react";
import type { PipelineToast } from "./pipeline-toast";

/**
 * Hook minimalista de toast stack para el kanban (M5).
 *
 * Se separa del board para que la lógica de notificación sea
 * reusable y testeable de manera aislada (R7 del prompt: solo
 * acciones manuales generan toast).
 */
export function useToastStack(): {
  toasts: PipelineToast[];
  push: (message: string, variant: PipelineToast["variant"]) => void;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<PipelineToast[]>([]);
  const idRef = useRef(0);

  const push = useCallback(
    (message: string, variant: PipelineToast["variant"]) => {
      idRef.current += 1;
      const t: PipelineToast = { id: idRef.current, message, variant };
      setToasts((cur) => [...cur, t]);
    },
    [],
  );

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  return { toasts, push, dismiss };
}
