"use client";
import { useEffect, useRef, useState } from "react";

interface Props {
  url: string;
}

/**
 * Iframe operativo del dashboard de Whaapy (M6 — B10).
 *
 * Estrategia inicial: iframe full-height en el container del layout.
 * Si el dashboard tiene sidebar visible y se requiere ocultarlo, el
 * próximo iteración aplica CSS de scroll-x con `margin-left` negativo
 * sobre el iframe — desplazando el sidebar fuera del viewport.
 *
 * Detección de bloqueo de embedding:
 *   - X-Frame-Options: DENY/SAMEORIGIN o CSP frame-ancestors restrictivo
 *     impiden la carga. El browser dispara `error` o el iframe queda
 *     en blanco. Usamos un timeout de 6s + flag `loaded` para
 *     diagnosticar el caso "no cargó nunca".
 *
 * Fallback: mensaje con link directo. El usuario sigue trabajando
 * con Whaapy en una pestaña aparte mientras se diagnostica.
 */
export function WhaapyFrame({ url }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    // Si tras 6s el iframe no disparó onLoad, asumimos bloqueo de
    // embedding. La heurística es imperfecta pero útil — Whaapy puede
    // estar lento (red en eventos), el usuario verá un mensaje de
    // diagnóstico y puede recargar manualmente.
    const t = setTimeout(() => {
      if (!loaded) setBlocked(true);
    }, 6000);
    return () => clearTimeout(t);
  }, [loaded]);

  if (blocked && !loaded) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <p className="text-base font-medium text-gray-700 dark:text-gray-200">
          No se pudo cargar Whaapy embebido.
        </p>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 max-w-md">
          Whaapy puede estar bloqueando el embebido o tu sesión expiró.
          Mientras se diagnostica, abre Whaapy directamente.
        </p>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 px-4 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700"
        >
          Abrir Whaapy en pestaña nueva
        </a>
        <p className="mt-3 text-[11px] text-gray-400 dark:text-gray-500">
          (URL: {url})
        </p>
      </div>
    );
  }

  return (
    <div className="h-full -m-6 flex flex-col">
      <iframe
        ref={iframeRef}
        src={url}
        title="Whaapy dashboard"
        onLoad={() => setLoaded(true)}
        onError={() => setBlocked(true)}
        className="flex-1 w-full border-0 bg-white"
        // sandbox controlado: permitir scripts (Whaapy es SPA) y
        // same-origin para que sus cookies de sesión funcionen, pero
        // sin top-navigation para que cualquier link interno no nos
        // saque del dashboard.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer-when-downgrade"
      />
    </div>
  );
}
