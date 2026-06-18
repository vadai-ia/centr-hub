import "server-only";
import {
  DEFAULT_GOAL_THRESHOLDS,
  sanitizeGoalThresholds,
  type GoalThresholds,
} from "@/lib/metas/semaphore";
import type { Json } from "@/lib/types/database";

/**
 * Lectura de los umbrales globales del semáforo desde
 * `organizations.config.metas` (M2v2 — Bloque 1). Espeja el patrón de
 * `readHideClosedDays` (pipeline-visibility): la app lee con FALLBACK al
 * default si la clave falta o es inválida, así una org nueva no necesita
 * tocar el bootstrap RPC. El saneo a la invariante `0 <= yellow <= green <=
 * 100` lo aplica `sanitizeGoalThresholds`.
 *
 * El default (rojo<50 · amarillo 50-84 · verde ≥85) está mirrored en el SQL
 * (seed de 0031) y en `DEFAULT_GOAL_THRESHOLDS` (semaphore.ts).
 */
export function readGoalThresholds(config: Json | null | undefined): GoalThresholds {
  let green: unknown;
  let yellow: unknown;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const metas = (config as Record<string, unknown>).metas;
    if (metas && typeof metas === "object" && !Array.isArray(metas)) {
      green = (metas as Record<string, unknown>).green_pct;
      yellow = (metas as Record<string, unknown>).yellow_pct;
    }
  }
  const greenNum = typeof green === "number" ? green : Number(green);
  const yellowNum = typeof yellow === "number" ? yellow : Number(yellow);
  // Si alguna falta/es inválida, sanitizeGoalThresholds cae al default por campo.
  return sanitizeGoalThresholds({
    greenPct: Number.isFinite(greenNum) ? greenNum : DEFAULT_GOAL_THRESHOLDS.greenPct,
    yellowPct: Number.isFinite(yellowNum) ? yellowNum : DEFAULT_GOAL_THRESHOLDS.yellowPct,
  });
}

/**
 * Serializa los umbrales saneados al shape que persiste en
 * `config.metas` (lo usa la acción admin de Bloque 3).
 */
export function goalThresholdsToConfig(thresholds: GoalThresholds): {
  green_pct: number;
  yellow_pct: number;
} {
  return { green_pct: thresholds.greenPct, yellow_pct: thresholds.yellowPct };
}
