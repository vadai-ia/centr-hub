import { z } from "zod";

/**
 * Constantes + validación de metas (M2v2 — Bloque 1). Módulo puro (sin
 * `server-only`): lo consumen las server actions (validación de input del
 * admin) y los Client Components (labels de métrica en UI). No importa nada
 * de runtime de servidor.
 */

/** Las tres métricas elegibles para una meta. */
export const GOAL_METRICS = ["quotes", "won", "amount"] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];

/** Etiqueta legible (español) de cada métrica. */
export const GOAL_METRIC_LABELS: Record<GoalMetric, string> = {
  quotes: "Cotizaciones enviadas",
  won: "Oportunidades ganadas",
  amount: "Monto vendido",
};

/** Descripción corta (qué mide) — tooltip/ayuda en la UI de admin. */
export const GOAL_METRIC_HINTS: Record<GoalMetric, string> = {
  quotes: "Cotizaciones generadas en el mes (actividad).",
  won: "Oportunidades concretadas en venta (cierre).",
  amount: "Monto total vendido en el mes (valor).",
};

/** Etiqueta corta para encabezados de columnas/grids compactos. */
export const GOAL_METRIC_SHORT: Record<GoalMetric, string> = {
  quotes: "Cotizaciones",
  won: "Órdenes",
  amount: "Monto",
};

/** `true` si la métrica se mide como conteo entero (quotes/won) vs monto. */
export function isCountMetric(metric: GoalMetric): boolean {
  return metric === "quotes" || metric === "won";
}

/**
 * Formatea un valor de meta para la UI: conteos como entero, monto como
 * `$` + miles. Pura (sin `server-only`) — usada en pantallas client.
 */
export function formatGoalValue(metric: GoalMetric, value: number): string {
  const n = isCountMetric(metric) ? Math.round(value) : value;
  const formatted = new Intl.NumberFormat("es-MX", {
    maximumFractionDigits: 0,
  }).format(n);
  return isCountMetric(metric) ? formatted : `$${formatted}`;
}

/**
 * Versión CORTA para celdas angostas (grid de comparación): conteos enteros;
 * monto en notación compacta ("$94 k", "$1.5 M").
 */
export function formatGoalValueShort(metric: GoalMetric, value: number): string {
  if (isCountMetric(metric)) {
    return new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 }).format(
      Math.round(value),
    );
  }
  const compact = new Intl.NumberFormat("es-MX", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
  return `$${compact}`;
}

export const goalMetricSchema = z.enum(GOAL_METRICS);

/**
 * Input del admin para crear/editar una meta. `advisorMembershipId` null =
 * meta general de equipo. `targetValue` se redondea a entero para métricas
 * de conteo en la capa de servicio (Bloque 3); aquí solo se valida ≥ 0.
 */
export const goalInputSchema = z.object({
  advisorMembershipId: z.string().uuid().nullable(),
  metric: goalMetricSchema,
  targetValue: z.coerce
    .number()
    .refine((n) => Number.isFinite(n), "El objetivo debe ser un número.")
    .min(0, "El objetivo no puede ser negativo."),
  isActive: z.boolean(),
});
export type GoalInput = z.infer<typeof goalInputSchema>;

/**
 * Input del admin para los umbrales globales del semáforo. El saneo a la
 * invariante `0 <= yellow <= green <= 100` lo hace `sanitizeGoalThresholds`
 * (semaphore.ts) en el servicio; aquí solo se acotan los rangos crudos.
 */
export const goalThresholdsInputSchema = z.object({
  greenPct: z.coerce.number().int().min(0).max(100),
  yellowPct: z.coerce.number().int().min(0).max(100),
});
export type GoalThresholdsInput = z.infer<typeof goalThresholdsInputSchema>;
