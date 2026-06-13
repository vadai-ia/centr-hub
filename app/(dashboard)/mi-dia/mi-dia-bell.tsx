"use client";
import { useTransition } from "react";
import type { MiDiaBellItem } from "@/lib/services/mi-dia";
import { dismissNotificationAction } from "@/lib/actions/mi-dia";
import { IconBell } from "./mi-dia-icons";

/**
 * Campanita de avisos (rediseño M1v2 correctivo). Antes pasaba
 * desapercibida (emoji chico). Ahora: botón grande con ring de acento,
 * ícono de línea, y un badge prominente de no-leídos — que LATE en rose
 * cuando hay alertas (no-accionables del admin), en indigo si son avisos
 * normales. Es el ÚNICO hogar de los avisos (el centro muestra tareas).
 */
export function MiDiaBell({
  items,
  open,
  onToggle,
  onClose,
  onView,
  onAfterAction,
}: {
  items: MiDiaBellItem[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onView: (oppId: string) => void;
  onAfterAction: () => void;
}) {
  const [, startTransition] = useTransition();
  const count = items.length;
  const hasAlert = items.some((i) => i.isAlert);
  const badgeColor = hasAlert ? "bg-rose-500" : "bg-indigo-600";

  function dismiss(id: string) {
    startTransition(async () => {
      await dismissNotificationAction({ id });
      onAfterAction();
    });
  }

  return (
    <div className="relative">
      <button
        onClick={onToggle}
        aria-label={`Avisos (${count})`}
        className={[
          "relative flex h-11 w-11 items-center justify-center rounded-2xl border transition-all",
          count > 0
            ? "border-indigo-200 bg-indigo-50 text-indigo-600 shadow-sm hover:bg-indigo-100 dark:border-indigo-900/50 dark:bg-indigo-950/40 dark:text-indigo-300"
            : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400",
        ].join(" ")}
      >
        <IconBell className="h-5 w-5" />
        {count > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center">
            {hasAlert && (
              <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${badgeColor} opacity-60`} />
            )}
            <span
              className={`relative flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-bold text-white shadow ${badgeColor}`}
            >
              {count > 9 ? "9+" : count}
            </span>
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={onClose} aria-hidden />
          <div className="absolute right-0 z-30 mt-2 w-80 max-w-[90vw] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl ring-1 ring-black/5 dark:border-slate-700 dark:bg-slate-800">
            <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-indigo-50 to-white px-4 py-2.5 dark:border-slate-700 dark:from-indigo-950/30 dark:to-slate-800">
              <span className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                <IconBell className="h-4 w-4 text-indigo-500" />
                Avisos
              </span>
              {count > 0 && (
                <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:ring-slate-600">
                  {count}
                </span>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {items.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-slate-400">Sin avisos.</p>
              ) : (
                items.map((it) => (
                  <div
                    key={it.id}
                    className={[
                      "flex gap-2.5 border-b border-slate-50 px-4 py-3 last:border-0 dark:border-slate-700/50",
                      it.isAlert ? "border-l-[3px] border-l-rose-400 bg-rose-50/30 dark:bg-rose-950/10" : "",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg text-xs",
                        it.isAlert
                          ? "bg-rose-100 text-rose-600 dark:bg-rose-900/40 dark:text-rose-300"
                          : "bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300",
                      ].join(" ")}
                      aria-hidden
                    >
                      {it.isAlert ? "!" : "•"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                        {it.title}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">
                        {it.message}
                      </p>
                      {it.opportunityId && (
                        <button
                          onClick={() => {
                            onClose();
                            onView(it.opportunityId!);
                          }}
                          className="mt-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
                        >
                          Ver oportunidad
                        </button>
                      )}
                    </div>
                    <button
                      onClick={() => dismiss(it.id)}
                      aria-label="Descartar"
                      className="h-5 shrink-0 text-slate-300 hover:text-slate-500"
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
