import {
  fillWidthPct,
  goalZoneLabel,
  resolveGoalZone,
  GOAL_MARKER_LEFT_PCT,
  type GoalThresholds,
  type GoalZone,
} from "@/lib/metas/semaphore";

/**
 * Barra-semáforo de avance de meta (M2v2 — Bloque 0). Presentacional puro
 * (sin estado, sin `"use client"`): se renderiza igual en el Dashboard
 * (Server Component) y en el widget Mi Día (dentro de un Client Component).
 *
 * Modelo visual (ver design tokens del milestone):
 *  - Escala fija 0–120%: la META (100%) es una marca fija a ~83% del track;
 *    la franja a su derecha es la "zona de bonus" donde el relleno DORADO se
 *    extiende al superar la meta.
 *  - Relleno coloreado por la ZONA del % actual (rojo/amarillo/verde) según
 *    los umbrales globales. En sobrecumplimiento: verde hasta la meta + dorado
 *    del 100% al % real.
 *  - El color NUNCA es el único indicador (a11y): siempre acompañan el % real
 *    (número) y la etiqueta de estado.
 *
 * `pct === null` → meta no medible → empty state "Sin meta asignada".
 */

// Mapas literales (Tailwind JIT necesita ver las clases completas en fuente).
const FILL_GRADIENT: Record<GoalZone, string> = {
  red: "bg-gradient-to-r from-rose-500 to-red-500",
  yellow: "bg-gradient-to-r from-amber-400 to-yellow-500",
  green: "bg-gradient-to-r from-emerald-500 to-green-500",
  // `gold` NO se pinta con este gradiente plano: el sobrecumplimiento usa la
  // superficie metálica `.goal-gold-surface` (globals.css). Esta entrada existe
  // solo para satisfacer el tipo Record<GoalZone> que indexa la rama no-dorada.
  gold: "bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-500",
};

const PCT_TEXT: Record<GoalZone, string> = {
  red: "text-rose-600 dark:text-rose-400",
  yellow: "text-amber-600 dark:text-amber-400",
  green: "text-emerald-600 dark:text-emerald-400",
  gold: "text-amber-600 dark:text-amber-400",
};

export interface GoalProgressBarProps {
  /** % real de avance (puede superar 100). `null` → empty state. */
  pct: number | null;
  thresholds: GoalThresholds;
  /** Etiqueta izquierda (nombre del vendedor, o la métrica). */
  title?: string;
  /** Detalle numérico a la derecha, ej. "12 / 20" o "$45,000 / $80,000". */
  valueLabel?: string;
  /** `md` = Dashboard; `sm` = widget compacto Mi Día. */
  size?: "md" | "sm";
  /** Muestra la fila de estado (icono + etiqueta de zona). Default true. */
  showStatus?: boolean;
  /** Texto del empty state (default "Sin meta asignada"). */
  emptyHint?: string;
}

export function GoalProgressBar({
  pct,
  thresholds,
  title,
  valueLabel,
  size = "md",
  showStatus = true,
  emptyHint = "Sin meta asignada",
}: GoalProgressBarProps) {
  if (pct === null) {
    return <GoalEmptyState title={title} hint={emptyHint} size={size} />;
  }

  const zone = resolveGoalZone(pct, thresholds);
  const isGold = zone === "gold";
  const fillW = fillWidthPct(pct);
  const pctText = `${Math.round(pct)}%`;
  const trackH = size === "sm" ? "h-2" : "h-2.5";
  const ariaNow = Math.round(Math.max(0, pct));

  return (
    <div className={size === "sm" ? "space-y-1.5" : "space-y-2"}>
      {/* Encabezado: título + valor + % */}
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2 min-w-0">
          {title && (
            <span
              className={[
                "truncate font-medium text-slate-700 dark:text-slate-200",
                size === "sm" ? "text-sm" : "text-sm",
              ].join(" ")}
            >
              {title}
            </span>
          )}
          {valueLabel && (
            <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500 tabular-nums">
              {valueLabel}
            </span>
          )}
        </div>
        <span
          className={[
            "shrink-0 font-bold tabular-nums",
            size === "sm" ? "text-base" : "text-lg",
            PCT_TEXT[zone],
          ].join(" ")}
        >
          {pctText}
        </span>
      </div>

      {/* Track + relleno + marca de meta */}
      <div
        className={[
          // Track siempre visible (incl. dark sobre tarjetas slate-800).
          "relative w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700",
          trackH,
          isGold ? "ring-1 ring-amber-400/70 dark:ring-amber-500/50 goal-gold-glow" : "",
        ].join(" ")}
        role="progressbar"
        aria-valuenow={ariaNow}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Avance de meta${title ? ` de ${title}` : ""}: ${pctText}, ${goalZoneLabel(zone)}`}
      >
        {isGold ? (
          <>
            {/* Verde hasta la meta */}
            <div
              className={`absolute inset-y-0 left-0 rounded-l-full ${FILL_GRADIENT.green}`}
              style={{ width: `${GOAL_MARKER_LEFT_PCT}%` }}
            />
            {/* Zona de bonus: oro pulido + barrido de luz diagonal (glare) */}
            <div
              className="goal-gold-surface absolute inset-y-0 overflow-hidden rounded-r-full"
              style={{ left: `${GOAL_MARKER_LEFT_PCT}%`, width: `${fillW - GOAL_MARKER_LEFT_PCT}%` }}
              aria-hidden
            >
              <span className="goal-gold-sheen" />
            </div>
          </>
        ) : (
          <div
            className={`absolute inset-y-0 left-0 rounded-full ${FILL_GRADIENT[zone]} motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-out`}
            style={{ width: `${fillW}%` }}
          />
        )}

        {/* Marca del 100% — siempre visible, incluso con el track vacío */}
        <div
          className="absolute inset-y-0 w-px bg-slate-400/70 dark:bg-slate-500/70"
          style={{ left: `${GOAL_MARKER_LEFT_PCT}%` }}
          aria-hidden
        />
      </div>

      {/* Estado (color + icono + texto — a11y: color no es el único indicador).
          En grids compactos se oculta (el % numérico ya es indicador no-color). */}
      {showStatus && (
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <ZoneIcon zone={zone} />
          <span className={PCT_TEXT[zone]}>{goalZoneLabel(zone)}</span>
        </div>
      )}
    </div>
  );
}

/** Empty state explícito — "Sin meta asignada" (Dashboard y Mi Día). */
export function GoalEmptyState({
  title,
  hint = "Sin meta asignada",
  size = "md",
}: {
  title?: string;
  hint?: string;
  size?: "md" | "sm";
}) {
  return (
    <div className={size === "sm" ? "space-y-1.5" : "space-y-2"}>
      {title && (
        <span className="block truncate text-sm font-medium text-slate-700 dark:text-slate-200">
          {title}
        </span>
      )}
      <div
        className={[
          "flex items-center justify-center gap-2 rounded-xl border border-dashed",
          "border-slate-200 bg-slate-50/60 text-center text-xs font-medium text-slate-400",
          "dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-500",
          size === "sm" ? "py-3" : "py-4",
        ].join(" ")}
      >
        <IconTarget className="h-4 w-4 shrink-0 opacity-70" />
        <span>{hint}</span>
      </div>
    </div>
  );
}

function ZoneIcon({ zone }: { zone: GoalZone }) {
  const cls = ["h-3.5 w-3.5 shrink-0", PCT_TEXT[zone]].join(" ");
  if (zone === "gold") return <IconSparkle className={cls} />;
  if (zone === "green") return <IconCheck className={cls} />;
  if (zone === "yellow") return <IconTrendingUp className={cls} />;
  return <IconAlert className={cls} />;
}

// ── Iconos inline (SVG, no emojis — pre-delivery checklist) ──────────────
function IconTarget({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconCheck({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
function IconTrendingUp({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m3 17 6-6 4 4 8-8" />
      <path d="M17 7h4v4" />
    </svg>
  );
}
function IconAlert({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}
function IconSparkle({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2l1.9 5.1L19 9l-5.1 1.9L12 16l-1.9-5.1L5 9l5.1-1.9L12 2z" />
      <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z" opacity="0.7" />
    </svg>
  );
}
