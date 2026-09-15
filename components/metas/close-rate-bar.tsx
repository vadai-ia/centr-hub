import type { CloseRate } from "@/lib/metas/achievement";

/**
 * Barra del % de cierre automático: de las cotizaciones del periodo, cuántas ya
 * se ganaron y pagaron. 100 cotizaciones y 30 pagadas = 30% de barra.
 *
 * NO usa el semáforo de metas a propósito: rojo/amarillo/verde significan
 * "cuánto llevas de tu objetivo", y aquí no hay objetivo. Un 30% de cierre en
 * rojo se leería como "va mal" sin ninguna referencia que lo sostenga. Por eso
 * el relleno es neutro y la escala es 0–100 real (sin marca de meta).
 *
 * Presentacional puro (sin `"use client"`), igual que `GoalProgressBar`.
 */
export function CloseRateBar({
  rate,
  title,
  size = "md",
  compact = false,
}: {
  rate: CloseRate;
  /** Etiqueta izquierda (nombre del vendedor o "% de cierre"). */
  title?: string;
  size?: "md" | "sm";
  /** Texto corto ("3 de 10") para celdas angostas del grid del Dashboard. */
  compact?: boolean;
}) {
  if (rate.pct === null) {
    return (
      <div className={size === "sm" ? "space-y-1.5" : "space-y-2"}>
        {title && (
          <span className="block truncate text-sm font-medium text-slate-700 dark:text-slate-200">
            {title}
          </span>
        )}
        <span className="block text-xs text-slate-400 dark:text-slate-500">
          Sin cotizaciones este mes
        </span>
      </div>
    );
  }

  const pct = Math.max(0, Math.min(100, rate.pct));
  const pctText = `${Math.round(pct)}%`;
  const detail = compact
    ? `${rate.quotesWon} de ${rate.quotes}`
    : `${rate.quotesWon} pagadas de ${rate.quotes} cotizaciones`;

  return (
    <div className={size === "sm" ? "space-y-1.5" : "space-y-2"}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          {title && (
            <span className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">
              {title}
            </span>
          )}
          <span className="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500">
            {detail}
          </span>
        </div>
        <span
          className={[
            "shrink-0 font-bold tabular-nums text-indigo-600 dark:text-indigo-400",
            size === "sm" ? "text-base" : "text-lg",
          ].join(" ")}
        >
          {pctText}
        </span>
      </div>
      <div
        className={[
          "relative w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700",
          size === "sm" ? "h-2" : "h-2.5",
        ].join(" ")}
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`% de cierre${title ? ` de ${title}` : ""}: ${pctText}, ${rate.quotesWon} pagadas de ${rate.quotes} cotizaciones`}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
