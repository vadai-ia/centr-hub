"use client";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { loadMyNotificationsAction } from "@/lib/actions/notifications";
import { dismissNotificationAction } from "@/lib/actions/mi-dia";
import {
  NOTIFICATIONS_REFRESH_MS,
  NOTIFICATION_TOAST_MAX,
  NOTIFICATION_TOAST_MS,
} from "@/lib/constants";
import { NotificationToasts } from "./notification-toasts";
import { notificationTarget } from "@/lib/services/notification-target";
import type { MiDiaBellItem } from "@/lib/services/mi-dia";

/**
 * Campanita de avisos — vive en el navbar, junto al nombre de usuario.
 *
 * Antes solo existía dentro de Mi Día, así que un aviso no se veía hasta
 * entrar a esa pantalla: justo lo contrario de para qué sirve una campanita.
 * Hay UNA sola en toda la aplicación — dos campanitas con dos fuentes de
 * datos acabarían mostrando conteos distintos en la misma pantalla.
 *
 * Se refresca sola, y **solo con la pestaña visible**: una pestaña olvidada
 * en segundo plano no tiene por qué seguir consultando.
 *
 * Además de la campanita emite los **avisos emergentes** (esquina inferior
 * derecha, estilo notificación del sistema). Van aquí y no en un componente
 * aparte porque salen de la MISMA consulta: dos consultas en paralelo
 * acabarían discrepando, y un emergente que anuncia algo que la campanita no
 * muestra es peor que no tener emergentes.
 */
export function NotificationsBell() {
  const router = useRouter();
  const [items, setItems] = useState<MiDiaBellItem[]>([]);
  const [open, setOpen] = useState(false);
  const [toasts, setToasts] = useState<MiDiaBellItem[]>([]);
  const [, startTransition] = useTransition();
  const cargando = useRef(false);
  /**
   * Avisos que esta pestaña ya anunció. Sin esto, la PRIMERA consulta haría
   * emerger todos los pendientes de golpe: al entrar por la mañana con cinco
   * recordatorios acumulados taparían la pantalla. Se siembra con lo que ya
   * había y de ahí en adelante solo emerge lo que llega nuevo.
   */
  const anunciados = useRef<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    if (cargando.current) return;
    cargando.current = true;
    try {
      const res = await loadMyNotificationsAction();
      if (!res.ok) return;
      setItems(res.items);

      if (anunciados.current === null) {
        // Primera consulta de la pestaña: lo que ya estaba pendiente no es
        // noticia, es trabajo acumulado. Va a la campanita, no a la pantalla.
        anunciados.current = new Set(res.items.map((i) => i.id));
        return;
      }
      const nuevos = res.items.filter((i) => !anunciados.current!.has(i.id));
      if (nuevos.length === 0) return;
      for (const n of nuevos) anunciados.current.add(n.id);
      setToasts((prev) => [...nuevos, ...prev].slice(0, NOTIFICATION_TOAST_MAX));
    } finally {
      cargando.current = false;
    }
  }, []);

  useEffect(() => {
    let cancelado = false;
    const tick = () => {
      if (cancelado) return;
      if (typeof document !== "undefined" && document.hidden) return;
      void refresh();
    };
    tick();
    const timer = window.setInterval(tick, NOTIFICATIONS_REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelado = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  function dismiss(id: string) {
    // Se quita de la lista en el acto: esperar al servidor para que
    // desaparezca hace que el click se sienta roto.
    setItems((prev) => prev.filter((i) => i.id !== id));
    setToasts((prev) => prev.filter((t) => t.id !== id));
    startTransition(async () => {
      await dismissNotificationAction({ id });
      void refresh();
    });
  }

  // Los emergentes NO-alerta se van solos. Los `alert` se quedan hasta que
  // alguien los cierre: son los que el admin tiene que ver sí o sí.
  useEffect(() => {
    const efimeros = toasts.filter((t) => !t.isAlert);
    if (efimeros.length === 0) return;
    const timer = window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.isAlert));
    }, NOTIFICATION_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toasts]);

  /**
   * Abrir el aviso lleva a lo que anuncia. El destino lo decide
   * `notificationTarget`, compartido con los emergentes y con el panel de
   * Mi Día: si cada sitio lo resolviera por su cuenta, el mismo aviso
   * llevaría a sitios distintos según dónde se tocara.
   */
  function abrir(item: MiDiaBellItem) {
    const destino = notificationTarget(item);
    if (!destino) return;
    setOpen(false);
    setToasts([]);
    router.push(destino.href);
  }

  const count = items.length;
  const hasAlert = items.some((i) => i.isAlert);
  const badgeColor = hasAlert ? "bg-rose-500" : "bg-indigo-600";

  return (
    <div className="relative">
      {/* Cerrar el emergente solo lo quita de la pantalla: el aviso sigue
          pendiente en la campanita. "Ya lo vi" no es "ya lo atendí". */}
      <NotificationToasts
        items={toasts}
        onClose={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))}
        onView={abrir}
      />
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Avisos (${count})`}
        className={[
          "relative flex h-9 w-9 items-center justify-center rounded-lg border transition-colors",
          count > 0
            ? "border-indigo-200 bg-indigo-50 text-indigo-600 hover:bg-indigo-100 dark:border-indigo-900/50 dark:bg-indigo-950/40 dark:text-indigo-300"
            : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400",
        ].join(" ")}
      >
        <BellIcon />
        {count > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center">
            {hasAlert && (
              <span
                className={`absolute inline-flex h-full w-full animate-ping rounded-full ${badgeColor} opacity-60`}
              />
            )}
            <span
              className={`relative flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white shadow ${badgeColor}`}
            >
              {count > 9 ? "9+" : count}
            </span>
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 z-30 mt-2 w-80 max-w-[90vw] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5 dark:border-gray-700">
              <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                Avisos
              </span>
              {count > 0 && (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                  {count}
                </span>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {count === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-gray-400 dark:text-gray-500">
                  Sin avisos.
                </p>
              ) : (
                items.map((it) => {
                  const destino = notificationTarget(it);
                  return (
                    <div
                      key={it.id}
                      // La FILA entera abre el aviso: un enlace pequeño al pie
                      // obliga a apuntar, y el gesto natural es tocar el aviso.
                      onClick={destino ? () => abrir(it) : undefined}
                      role={destino ? "button" : undefined}
                      tabIndex={destino ? 0 : undefined}
                      onKeyDown={
                        destino
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                abrir(it);
                              }
                            }
                          : undefined
                      }
                      className={[
                        "flex gap-2.5 border-b border-gray-50 px-4 py-3 last:border-0 dark:border-gray-700/50",
                        destino
                          ? "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40"
                          : "",
                        it.isAlert
                          ? "border-l-[3px] border-l-rose-400 bg-rose-50/30 dark:bg-rose-950/10"
                          : "",
                      ].join(" ")}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
                          {it.title}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
                          {it.message}
                        </p>
                        {destino && (
                          <span className="mt-1 inline-block text-xs font-medium text-indigo-600 dark:text-indigo-400">
                            {destino.label} →
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        // Descartar NO debe abrir el aviso: el clic de la ✕
                        // viaja hacia arriba hasta la fila si no se detiene.
                        onClick={(e) => {
                          e.stopPropagation();
                          dismiss(it.id);
                        }}
                        aria-label="Descartar"
                        className="h-5 shrink-0 text-gray-300 hover:text-gray-500"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function BellIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}
