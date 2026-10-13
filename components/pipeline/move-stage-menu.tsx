"use client";
import { useEffect, useRef, useState } from "react";
import type { PipelineStageRow, UUID } from "@/lib/types/database";

/**
 * "Mover a etapa" — la vía que NO obliga a arrastrar.
 *
 * El tablero de Venta tiene once columnas y el de Post-venta siete, así que
 * llevar una tarjeta de la primera a la última exige cruzar media pantalla
 * con el botón apretado. Antes el tablero se desplazaba solo al acercarse al
 * borde, pero ese desplazamiento automático se desbocaba y hubo que apagarlo
 * (ver `AUTO_SCROLL` en el tablero). Este menú cubre justamente ese caso y de
 * paso lo hace mejor: un clic, sin puntería.
 *
 * Dispara EXACTAMENTE el mismo camino que soltar la tarjeta — motivo de
 * pérdida, entrega de Outbound y movimiento optimista incluidos. Si tuviera
 * un atajo propio, mover por menú y mover arrastrando acabarían divergiendo
 * en las reglas.
 */
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
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (stages.length <= 1) return null;

  return (
    <div
      ref={boxRef}
      className="relative"
      // La tarjeta entera es el asa del arrastre: sin detener el pointer
      // aquí, abrir el menú empieza a arrastrar la tarjeta.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
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
          <path d="m8 3-5 4 5 4" />
          <path d="M3 7h12a4 4 0 0 1 0 8h-1" />
          <path d="m16 21 5-4-5-4" />
          <path d="M21 17H9a4 4 0 0 1 0-8h1" />
        </svg>
        {variant === "button" && "Mover a etapa"}
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-1 w-52 top-full overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-xl dark:border-gray-700 dark:bg-gray-800">
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
                    setOpen(false);
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
        </div>
      )}
    </div>
  );
}
