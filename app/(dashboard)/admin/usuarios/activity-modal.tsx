"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadUserActivityAction } from "@/lib/actions/presence";
import {
  groupSessionsByDay,
  type ActivityDayView,
} from "@/lib/services/presence-display";
import type { ManagedUserView } from "@/lib/types/admin";

interface Props {
  open: boolean;
  user: ManagedUserView | null;
  onClose: () => void;
}

/**
 * Modal "Actividad" (0057). El historial corto que se pidió: por día, de
 * tal hora a tal hora.
 *
 * Se carga al abrir y no se precarga con la pantalla: son datos que solo
 * interesan cuando alguien pregunta por una persona concreta, y traerlos
 * para todo el equipo en cada render del listado sería gratis para nadie.
 */
export function ActivityModal({ open, user, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<ActivityDayView[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (membershipId: string) => {
    setLoading(true);
    setError(null);
    const res = await loadUserActivityAction({ membershipId });
    setLoading(false);
    if (!res.ok) {
      setError(res.message);
      setDays([]);
      return;
    }
    setDays(groupSessionsByDay(res.sessions, res.now, res.timezone));
  }, []);

  useEffect(() => {
    if (!open || !user) return;
    setDays([]);
    void load(user.membershipId);
  }, [open, user, load]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !user) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-gray-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="activity-title"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 outline-none max-h-[80vh] flex flex-col"
      >
        <p
          id="activity-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          Actividad de {user.fullName}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Cuándo estuvo usando la plataforma. Cada tramo termina en su última
          señal: cerrar la pestaña o quedarse sin red no avisa.
        </p>

        <div className="mt-4 overflow-y-auto min-h-0 flex-1">
          {loading && (
            <p className="text-sm text-gray-400 dark:text-gray-500 py-6 text-center">
              Cargando…
            </p>
          )}

          {!loading && error && (
            <div
              role="alert"
              className="px-3 py-2 rounded-md bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300 text-sm"
            >
              {error}
            </div>
          )}

          {!loading && !error && days.length === 0 && (
            <p className="text-sm text-gray-400 dark:text-gray-500 py-6 text-center">
              Sin actividad registrada todavía.
            </p>
          )}

          <ul className="space-y-4">
            {days.map((day) => (
              <li key={day.key}>
                <div className="flex items-baseline justify-between gap-3 mb-1.5">
                  <p className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                    {day.label}
                  </p>
                  <p className="text-xs text-gray-400 dark:text-gray-500">
                    {day.total}
                  </p>
                </div>
                <ul className="space-y-1">
                  {day.sessions.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center justify-between gap-3 text-sm rounded-md bg-gray-50 dark:bg-gray-700/40 px-3 py-1.5"
                    >
                      <span className="text-gray-700 dark:text-gray-200">
                        {s.from} – {s.ongoing ? "ahora" : s.to}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {s.duration}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex justify-end pt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
