"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PipelineStageRow, UUID } from "@/lib/types/database";

/**
 * "Mover a etapa" — la vía que NO obliga a arrastrar.
 *
 * El tablero de Venta tiene once columnas y el de Post-venta siete, así que
 * llevar una tarjeta de la primera a la última exige cruzar media pantalla
 * con el botón apretado. Antes el tablero se desplazaba solo al acercarse al
 * borde, pero ese desplazamiento se desbocaba y hubo que apagarlo (ver
 * `AUTO_SCROLL` en el tablero). Este menú cubre ese caso y de paso lo hace
 * mejor: un clic, sin puntería.
 *
 * Dispara EXACTAMENTE el mismo camino que soltar la tarjeta — motivo de
 * pérdida, entrega de Outbound y movimiento optimista incluidos. Si tuviera
 * un atajo propio, mover por menú y mover arrastrando acabarían divergiendo
 * en las reglas.
 */

/** `w-52`. Se necesita en número para encajar el menú dentro de la pantalla. */
const ANCHO = 208;
/** Alto estimado para decidir si abre hacia arriba. No tiene que ser exacto. */
const ALTO_APROX = 300;
const MARGEN = 8;

interface Coords {
  left: number;
  /** Se ancla por arriba o por abajo según quepa. */
  top?: number;
  bottom?: number;
}

export function MoveStageMenu({
  stages,
  currentStageId,
  onMove,
  variant = "icon",
}: {
  /** Etapas del funnel activo, en orden. */
  stages: PipelineStageRow[];
  currentStageId: UUID;
  onMove: (toStageId: UUID) => void;
  /**
   * `icon` en la tarjeta del tablero, donde el espacio es el que es;
   * `button` en el detalle, donde la acción tiene que ser encontrable sin
   * adivinar — ahí es el primer sitio donde la gente la busca.
   */
  variant?: "icon" | "button";
}) {
  const [coords, setCoords] = useState<Coords | null>(null);
  const botonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = coords !== null;

  const abrir = useCallback(() => {
    const r = botonRef.current?.getBoundingClientRect();
    if (!r) return;
    // Alineado a la derecha del botón, pero sin salirse de la pantalla.
    const left = Math.max(
      MARGEN,
      Math.min(r.right - ANCHO, window.innerWidth - ANCHO - MARGEN),
    );
    const cabeAbajo = r.bottom + ALTO_APROX < window.innerHeight;
    setCoords(
      cabeAbajo
        ? { left, top: r.bottom + 4 }
        : { left, bottom: window.innerHeight - r.top + 4 },
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (botonRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setCoords(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setCoords(null);
    }
    // El menú va en un portal con posición fija: si algo se desplaza o la
    // ventana cambia de tamaño, dejaría de apuntar a su botón. Cerrarlo es
    // más honesto que dejarlo flotando en un sitio que ya no significa nada.
    function cerrar() {
      setCoords(null);
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", cerrar);
    window.addEventListener("scroll", cerrar, true);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", cerrar);
      window.removeEventListener("scroll", cerrar, true);
    };
  }, [open]);

  if (stages.length <= 1) return null;

  return (
    <div
      className="relative"
      // La tarjeta entera es el asa del arrastre: sin detener el pointer
      // aquí, abrir el menú empieza a arrastrar la tarjeta.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        ref={botonRef}
        type="button"
        onClick={() => (open ? setCoords(null) : abrir())}
        aria-label="Mover a otra etapa"
        aria-expanded={open}
        className={
          variant === "button"
            ? "inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
            : "flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
        }
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width={variant === "button" ? "15" : "13"}
          height={variant === "button" ? "15" : "13"}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          {/*
            Flecha con punta en LOS DOS extremos. Una flecha simple a la
            derecha hace que la gente asuma que el menú solo adelanta; un
            icono de "sincronizar" se lee bien pero ya no parece una flecha.
            Con las dos puntas se entiende de un vistazo: mover, en cualquier
            dirección.
          */}
          <path d="M3 12h18" />
          <path d="m7 7-5 5 5 5" />
          <path d="m17 7 5 5-5 5" />
        </svg>
        {variant === "button" && "Mover a etapa"}
      </button>

      {/*
        En un PORTAL a propósito: la lista de la columna tiene scroll propio,
        y un desplegable normal se recortaba contra ese borde — se veían los
        nombres de las etapas cortados por la mitad. Fuera del árbol de la
        columna no hay nada que lo recorte.
      */}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            style={{ left: coords.left, top: coords.top, bottom: coords.bottom }}
            className="fixed z-[70] w-52 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-xl dark:border-gray-700 dark:bg-gray-800"
          >
            <p className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
              Mover a — adelante o atrás
            </p>
            <div className="max-h-64 overflow-y-auto">
              {stages.map((s) => {
                const esActual = s.id === currentStageId;
                return (
                  <button
                    key={s.id}
                    type="button"
                    disabled={esActual}
                    onClick={() => {
                      setCoords(null);
                      onMove(s.id);
                    }}
                    className={[
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                      esActual
                        ? "cursor-default bg-gray-50 font-medium text-gray-500 dark:bg-gray-700/40 dark:text-gray-400"
                        : "text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700",
                    ].join(" ")}
                  >
                    <span
                      className="h-2 w-2 flex-shrink-0 rounded-full"
                      style={{ backgroundColor: s.color }}
                      aria-hidden
                    />
                    <span className="truncate">{s.name}</span>
                    {esActual && (
                      <span className="ml-auto text-[10px] text-gray-400">actual</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
