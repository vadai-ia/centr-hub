"use client";
import { useTransition } from "react";
import type { MiDiaBellItem } from "@/lib/services/mi-dia";
import { dismissNotificationAction } from "@/lib/actions/mi-dia";

/**
 * Campanita de avisos. Feed liviano SEPARADO del centro: incluye avisos
 * que no mapean a una oportunidad puntual (ej. alerta al admin). Todo
 * in-app (no email/WhatsApp).
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
        className="relative rounded-full border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
      >
        <span className="text-lg leading-none">🔔</span>
        {count > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-indigo-600 px-1 text-[11px] font-semibold text-white">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={onClose} aria-hidden />
          <div className="absolute right-0 z-30 mt-2 w-80 max-w-[90vw] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-800">
            <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-200">
              Avisos
            </div>
            <div className="max-h-96 overflow-y-auto">
              {items.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-slate-400">Sin avisos.</p>
              ) : (
                items.map((it) => (
                  <div
                    key={it.id}
                    className={[
                      "flex gap-2 border-b border-slate-50 px-4 py-3 last:border-0 dark:border-slate-700/50",
                      it.isAlert ? "border-l-2 border-l-rose-400" : "",
                    ].join(" ")}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                        {it.isAlert && <span className="mr-1">⚠️</span>}
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
