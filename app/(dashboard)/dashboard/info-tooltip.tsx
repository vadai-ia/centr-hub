"use client";
import { useId, useState } from "react";

/**
 * Tooltip explicativo de KPI (M8.2 rediseño). Texto 100% ESTÁTICO — no
 * pega a BD ni recalcula nada (requisito del prompt). Accesible: el
 * trigger es un <button> enfocable; el popover se muestra en hover y en
 * focus de teclado, con `aria-describedby`/`role="tooltip"`. Sin
 * dependencias nuevas (no Radix) — sólo estado local.
 *
 * El popover se posiciona `absolute` centrado bajo el ícono y con
 * z-index alto; las tarjetas KPI NO usan `overflow-hidden` para que el
 * tooltip pueda desbordar la tarjeta.
 */
export function InfoTooltip({ label, content }: { label: string; content: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-flex items-center align-middle">
      <button
        type="button"
        aria-label={`Qué es ${label}`}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((o) => !o)}
        className="flex h-4 w-4 items-center justify-center rounded-full text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
          <path
            fillRule="evenodd"
            d="M8 15A7 7 0 108 1a7 7 0 000 14zm-.75-9.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM7.25 7.5a.75.75 0 01.75-.75h.01a.75.75 0 01.74.75v3.25a.75.75 0 01-1.5 0V7.5z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open ? (
        <span
          role="tooltip"
          id={id}
          className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 w-60 -translate-x-1/2 rounded-lg bg-gray-900 px-3 py-2 text-xs font-normal normal-case leading-relaxed tracking-normal text-gray-100 shadow-lg ring-1 ring-black/10 dark:bg-gray-700"
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
