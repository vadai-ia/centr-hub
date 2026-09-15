import type { GoalMetricDb } from "@/lib/types/database";

/**
 * Tally de logro de un sujeto en un periodo. Espejo estructural de
 * `ScopeAchievement` (lib/services/dashboard-metrics.ts), que es quien lo
 * produce a partir de las mismas fuentes del Dashboard.
 */
export interface AchievementTally {
  quotes: number; // cotizaciones creadas en el periodo
  won: number; // oportunidades ganadas en el periodo
  amount: number; // monto de pedidos pagados
  quotesWon: number; // de esas cotizaciones, cuántas ya se ganaron (cohorte)
}

/**
 * Valor logrado de una métrica de meta a partir del tally. Definición ÚNICA,
 * compartida por el avance en vivo (goal-progress) y el snapshot mensual
 * (goal-snapshot): si divergieran, el mes en curso y el histórico dirían cosas
 * distintas del mismo mes.
 *
 * Vive en un módulo PURO, fuera de dashboard-metrics (server-only, con acceso a
 * BD), para que ambos servicios la compartan sin arrastrar la capa de datos.
 *
 * `close_rate` (0053) es un porcentaje 0–100: cotizaciones ganadas ÷
 * cotizaciones del periodo, por cohorte. Sin cotizaciones devuelve 0: no hay
 * nada que cerrar.
 */
/**
 * % de cierre de un vendedor (o del equipo) en un periodo, SIN objetivo: de las
 * cotizaciones que hizo, cuántas ya se ganaron y pagaron (una opp pasa a
 * "Ganada" con `orders/paid`). 100 cotizaciones y 30 pagadas = 30%.
 *
 * Por cohorte, igual que `close_rate`: solo cuentan las ganadas de ESAS
 * cotizaciones, así nunca pasa de 100% ni se infla con cierres de meses
 * anteriores. `pct` es null sin cotizaciones (no hay nada que medir).
 */
export interface CloseRate {
  quotes: number;
  quotesWon: number;
  pct: number | null;
}

export function closeRateOf(a: Pick<AchievementTally, "quotes" | "quotesWon">): CloseRate {
  return {
    quotes: a.quotes,
    quotesWon: a.quotesWon,
    pct: a.quotes > 0 ? (a.quotesWon / a.quotes) * 100 : null,
  };
}

export function achievedForMetric(metric: GoalMetricDb, a: AchievementTally): number {
  switch (metric) {
    case "quotes":
      return a.quotes;
    case "won":
      return a.won;
    case "amount":
      return a.amount;
    case "close_rate":
      return a.quotes > 0 ? (a.quotesWon / a.quotes) * 100 : 0;
  }
}
