"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { dismissNotificationAction } from "@/lib/actions/mi-dia";
import { notificationTarget } from "@/lib/services/notification-target";
import type { MiDiaBellItem } from "@/lib/services/mi-dia";

/**
 * Panel de avisos dentro de Mi Día.
 *
 * La campanita del navbar es para enterarse de paso: cabe poco y se cierra al
 * tocar fuera. Aquí los avisos se LEEN — el mensaje completo, sin recortar, y
 * con sitio para repasarlos uno por uno mientras se trabaja la jornada. Es la
 * misma lista y la misma acción de descartar, así que lo que se atienda en un
 * sitio desaparece del otro.
 *
 * Mi Día ya recibe `bell` en su carga: no hay consulta nueva ni una segunda
 * fuente que pudiera discrepar del conteo de la campanita.
 */
export function MiDiaNotifications({
  items,
  onChange,
}: {
  items: MiDiaBellItem[];
  /** Recarga Mi Día tras descartar, para que el panel refleje el cambio. */
  onChange: () => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  function descartar(id: string) {
    startTransition(async () => {
      await dismissNotificationAction(id);
      onChange();
    });
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700/60 dark:bg-slate-800/50">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Avisos
        </h3>
        {items.length > 0 && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-slate-700 dark:text-slate-300">
            {items.length}
          </span>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-slate-400">Sin avisos pendientes.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((it) => {
            const destino = notificationTarget(it);
            return (
              <li
                key={it.id}
                className={[
                  "rounded-lg border px-3 py-2",
                  it.isAlert
                    ? "border-rose-200 bg-rose-50/50 dark:border-rose-900/40 dark:bg-rose-950/20"
                    : "border-slate-200 bg-slate-50/60 dark:border-slate-700/60 dark:bg-slate-900/30",
                ].join(" ")}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                      {it.title}
                    </p>
                    {/* Sin recortar: aquí se viene a LEER. En la campanita el
                        mensaje va a dos líneas porque ahí solo se ojea. */}
                    <p className="mt-0.5 text-xs leading-snug text-slate-500 dark:text-slate-400">
                      {it.message}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => descartar(it.id)}
                    aria-label="Descartar aviso"
                    className="shrink-0 text-slate-300 hover:text-slate-500 dark:hover:text-slate-300"
                  >
                    ✕
                  </button>
                </div>
                {destino && (
                  <button
                    type="button"
                    onClick={() => router.push(destino.href)}
                    className="mt-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
                  >
                    {destino.label} →
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
