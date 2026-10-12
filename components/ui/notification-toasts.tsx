"use client";
import type { MiDiaBellItem } from "@/lib/services/mi-dia";

/**
 * Avisos emergentes, estilo notificación del sistema: aparecen en la esquina
 * inferior derecha, encima de cualquier pantalla, y se van solos.
 *
 * Presentacional a propósito — quién decide CUÁL emerge y cuándo desaparece
 * vive en la campanita, que ya consulta los avisos. Dos consultas en paralelo
 * (una para la campanita y otra para los emergentes) acabarían discrepando.
 *
 * **Cerrar el emergente NO descarta el aviso**: solo lo quita de la pantalla.
 * El aviso sigue en la campanita hasta que la persona lo descarte ahí. Es la
 * diferencia entre "ya lo vi" y "ya lo atendí", y confundirlas haría
 * desaparecer pendientes sin que nadie los atienda.
 */
export function NotificationToasts({
  items,
  onClose,
  onView,
}: {
  items: MiDiaBellItem[];
  onClose: (id: string) => void;
  onView: (opportunityId: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div
      // `pointer-events-none` en el contenedor y `auto` en cada tarjeta: el
      // contenedor ocupa una esquina entera de la pantalla y sin esto
      // bloquearía los clicks de lo que haya debajo aunque esté vacío.
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      aria-live="polite"
    >
      {items.map((it) => (
        <div
          key={it.id}
          role={it.isAlert ? "alert" : "status"}
          className={[
            "pointer-events-auto overflow-hidden rounded-xl border bg-white shadow-lg dark:bg-gray-800",
            it.isAlert
              ? "border-rose-200 dark:border-rose-500/40"
              : "border-gray-200 dark:border-gray-700",
          ].join(" ")}
        >
          <div className="flex items-start gap-2.5 p-3">
            <span
              className={[
                "mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg text-xs font-bold",
                it.isAlert
                  ? "bg-rose-100 text-rose-600 dark:bg-rose-900/40 dark:text-rose-300"
                  : "bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300",
              ].join(" ")}
              aria-hidden
            >
              {it.isAlert ? "!" : "•"}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                {it.title}
              </p>
              <p className="mt-0.5 line-clamp-3 text-xs text-gray-600 dark:text-gray-400">
                {it.message}
              </p>
              {it.opportunityId && (
                <button
                  type="button"
                  onClick={() => onView(it.opportunityId!)}
                  className="mt-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
                >
                  Ver oportunidad
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => onClose(it.id)}
              aria-label="Cerrar aviso"
              className="h-5 shrink-0 text-gray-300 hover:text-gray-500 dark:hover:text-gray-300"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
