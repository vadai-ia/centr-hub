"use client";
import { useEffect } from "react";

export interface PipelineToast {
  id: number;
  message: string;
  variant: "success" | "info" | "error";
}

interface Props {
  toasts: PipelineToast[];
  onDismiss: (id: number) => void;
}

/**
 * Toast container del pipeline (M5).
 *
 * Las notificaciones se generan SOLO desde acciones iniciadas por
 * el usuario (drag manual, modal confirm). Los movimientos
 * automáticos por webhook NO emiten toast — solo se reflejan via
 * Realtime (regla del prompt M5).
 *
 * Auto-dismiss tras 3.5s. Click en la X cierra inmediatamente.
 * Diseño minimalista — F7 itera estética.
 */
export function PipelineToastStack({ toasts, onDismiss }: Props) {
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 max-w-sm"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: PipelineToast;
  onDismiss: (id: number) => void;
}) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), 3500);
    return () => clearTimeout(timer);
  }, [onDismiss, toast.id]);

  const styles = {
    success:
      "bg-emerald-50 text-emerald-900 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-100 dark:border-emerald-800",
    info: "bg-sky-50 text-sky-900 border-sky-200 dark:bg-sky-900/40 dark:text-sky-100 dark:border-sky-800",
    error:
      "bg-rose-50 text-rose-900 border-rose-200 dark:bg-rose-900/40 dark:text-rose-100 dark:border-rose-800",
  }[toast.variant];

  return (
    <div
      role={toast.variant === "error" ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-md ${styles}`}
    >
      <span className="flex-1">{toast.message}</span>
      <button
        type="button"
        aria-label="Cerrar notificación"
        className="opacity-60 hover:opacity-100"
        onClick={() => onDismiss(toast.id)}
      >
        ✕
      </button>
    </div>
  );
}
