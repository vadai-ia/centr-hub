"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { dismissNotificationAction } from "@/lib/actions/mi-dia";
import { notificationTarget } from "@/lib/services/notification-target";
import {
  filterByAge,
  NOTIFICATION_AGE_DEFAULT,
  NOTIFICATION_AGE_OPTIONS,
  type NotificationAge,
} from "@/lib/services/notification-filter";
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
  const [edad, setEdad] = useState<NotificationAge>(NOTIFICATION_AGE_DEFAULT);
  const visibles = useMemo(() => filterByAge(items, edad), [items, edad]);

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
        <div className="flex items-center gap-1.5">
          {items.length > 0 && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-slate-700 dark:text-slate-300">
              {/* Cuando hay filtro se muestran los dos números: si solo
                  saliera el filtrado, un panel vacío se leería como "ya no
                  tengo nada pendiente". */}
              {edad === "all"
                ? items.length
                : `${visibles.length} de ${items.length}`}
            </span>
          )}
          {items.length > 0 && (
            <select
              value={edad}
              onChange={(e) => setEdad(e.target.value as NotificationAge)}
              aria-label="Filtrar avisos por antigüedad"
              className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
            >
              {NOTIFICATION_AGE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {visibles.length === 0 ? (
        <p className="text-xs text-slate-400">
          {items.length === 0
            ? "Sin avisos pendientes."
            : "Ninguno en ese periodo. Cambia el filtro para ver el resto."}
        </p>
      ) : (
        /*
         * Altura FIJA con scroll propio, como las columnas del pipeline.
         * Pintarlos todos estiraba la página: con cien avisos pendientes el
         * lateral medía varias pantallas y el resto de Mi Día quedaba
         * enterrado debajo.
         *
         * Alto fijo y no proporcional a la pantalla porque este panel tiene
         * hermanos en la misma columna (racha, clientes silenciosos, la
         * semana): uno que creciera con el viewport los empujaría fuera de
         * vista, que es el mismo problema por la otra punta. El total sigue
         * en la cabecera, así que se sabe cuántos quedan más abajo.
         */
        <ul className="max-h-[26rem] space-y-2 overflow-y-auto pr-1 centr-scrollbar">
          {visibles.map((it) => {
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
