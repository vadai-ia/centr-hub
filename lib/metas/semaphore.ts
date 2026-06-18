/**
 * Lógica pura del semáforo de metas (M2v2 — Bloque 0).
 *
 * NO es `server-only`: se consume en Server Components (Dashboard,
 * histórico) y en Client Components (widget Mi Día, barras interactivas).
 * Mantener este módulo sin imports de `lib/db`, `server-only` ni nada de
 * runtime de servidor — es matemática + tokens, reutilizable en ambos lados.
 *
 * El semáforo traduce un % de avance contra la meta a una "zona" de color.
 * Los dos cortes (`greenPct`, `yellowPct`) son los UMBRALES GLOBALES de la
 * organización (configurables por el admin desde la pestaña Metas, Bloque
 * 3). El MISMO set aplica a las tres métricas (cotizaciones / órdenes /
 * monto) porque todas se miden como % contra su propio objetivo.
 */

/** Zona del semáforo. `gold` = sobrecumplimiento (> 100%). */
export type GoalZone = "red" | "yellow" | "green" | "gold";

/**
 * Umbrales globales del semáforo. Verde si `pct >= greenPct`; amarillo si
 * `pct >= yellowPct`; rojo debajo. `gold` se deriva aparte (pct > 100),
 * independiente de los cortes — superar la meta SIEMPRE es dorado.
 *
 * Invariante: `0 <= yellowPct <= greenPct <= 100`.
 */
export interface GoalThresholds {
  greenPct: number;
  yellowPct: number;
}

/** Default razonable de arranque (decisión M2v2): rojo<50 · amarillo 50-84 · verde ≥85. */
export const DEFAULT_GOAL_THRESHOLDS: GoalThresholds = {
  greenPct: 85,
  yellowPct: 50,
};

/**
 * Techo de la escala visual de la barra. La meta (100%) se dibuja como
 * marca fija; la zona a su derecha (100→120%) es el "bonus" donde el
 * relleno dorado se extiende. Fijo para que las barras de distintos
 * vendedores sean comparables (no se reescala por valor). El % REAL
 * siempre se muestra como número aunque supere el techo.
 */
export const GOAL_DISPLAY_CEILING_PCT = 120;

/** Posición (% del ancho del track) donde vive la marca del 100%. */
export const GOAL_MARKER_LEFT_PCT = (100 / GOAL_DISPLAY_CEILING_PCT) * 100; // 83.33…

/**
 * Sanea un par de umbrales capturado por el admin a la invariante
 * `0 <= yellow <= green <= 100`. Espeja el patrón de `sanitizeHideClosedDays`
 * (pipeline-visibility): la UI puede mandar basura; el saneo es la frontera.
 */
export function sanitizeGoalThresholds(input: {
  greenPct: number;
  yellowPct: number;
}): GoalThresholds {
  const green = clampInt(input.greenPct, 0, 100, DEFAULT_GOAL_THRESHOLDS.greenPct);
  // amarillo nunca puede superar al verde (zona amarilla quedaría vacía/invertida).
  const yellow = clampInt(input.yellowPct, 0, green, DEFAULT_GOAL_THRESHOLDS.yellowPct);
  return { greenPct: green, yellowPct: yellow };
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return Math.min(max, Math.max(min, fallback));
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * % de avance = logrado / objetivo * 100. Devuelve `null` si el objetivo es
 * 0/negativo (no hay meta medible → la UI muestra el empty state, no 0%).
 */
export function computeGoalPct(achieved: number, target: number): number | null {
  if (!Number.isFinite(target) || target <= 0) return null;
  const pct = (achieved / target) * 100;
  return Number.isFinite(pct) ? Math.max(0, pct) : null;
}

/** Zona de color para un % dado. > 100 siempre es `gold`. */
export function resolveGoalZone(pct: number, thresholds: GoalThresholds): GoalZone {
  if (pct > 100) return "gold";
  if (pct >= thresholds.greenPct) return "green";
  if (pct >= thresholds.yellowPct) return "yellow";
  return "red";
}

/**
 * Ancho del relleno como % del track (0–100 del ANCHO visual), mapeando el
 * % real contra el techo de la escala. Clamp a [0, 100] del track.
 */
export function fillWidthPct(pct: number): number {
  const clamped = Math.min(GOAL_DISPLAY_CEILING_PCT, Math.max(0, pct));
  return (clamped / GOAL_DISPLAY_CEILING_PCT) * 100;
}

/** Etiqueta de estado en español por zona (acompaña al color — a11y). */
export function goalZoneLabel(zone: GoalZone): string {
  switch (zone) {
    case "gold":
      return "¡Superaste la meta!";
    case "green":
      return "En meta";
    case "yellow":
      return "En camino";
    case "red":
      return "Lejos de la meta";
  }
}
