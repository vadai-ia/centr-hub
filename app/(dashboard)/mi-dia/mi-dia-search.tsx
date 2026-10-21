"use client";

/**
 * Buscador de las listas largas de Mi Día.
 *
 * Mismo componente en "El resto" y en "Oportunidades sin asignar": dos
 * buscadores con aspecto o reglas distintas en la misma pantalla
 * desconciertan.
 */
export function MiDiaSearch({
  value,
  onChange,
  placeholder = "Buscar por nombre o folio…",
  resultCount,
  total,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Cuántas quedan tras filtrar. Solo se muestra cuando hay búsqueda. */
  resultCount: number;
  total: number;
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <div className="relative flex-1">
        <input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-2 text-sm text-slate-700 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
        />
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
          aria-hidden
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      </div>
      {value.trim().length > 0 && (
        // Cuántas de cuántas: sin esa referencia, una lista corta tras
        // filtrar se lee como "ya no queda nada".
        <span className="shrink-0 text-xs tabular-nums text-slate-400">
          {resultCount} de {total}
        </span>
      )}
    </div>
  );
}
