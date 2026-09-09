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
export const goalInputSchema = z
  .object({
    // Sujeto explícito (0051). Opcional para no romper llamadas previas: si
    // falta, se infiere como antes (sin vendedor = equipo).
    subject: z.enum(["team", "advisor", "organic"]).optional(),
    advisorMembershipId: z.string().uuid().nullable(),
    metric: goalMetricSchema,
    targetValue: z.coerce
      .number()
      .refine((n) => Number.isFinite(n), "El objetivo debe ser un número.")
      .min(0, "El objetivo no puede ser negativo."),
    isActive: z.boolean(),
  })
  .transform((v) => ({
    ...v,
    subject:
      v.subject ?? (v.advisorMembershipId === null ? ("team" as const) : ("advisor" as const)),
  }))
  .superRefine((v, ctx) => {
    // Los mismos invariantes que los CHECK de 0051, pero con mensaje en
    // español: la BD es la garantía, esto es la cortesía.
    if (v.subject === "advisor" && v.advisorMembershipId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Elige el vendedor de la meta.",
        path: ["advisorMembershipId"],
      });
    }
    if (v.subject !== "advisor" && v.advisorMembershipId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Una meta de equipo o de venta orgánica no lleva vendedor.",
        path: ["advisorMembershipId"],
      });
    }
    if (v.subject === "organic" && v.metric !== "amount") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "La venta orgánica solo se mide en monto: no lleva cotización enviada ni oportunidad trabajada.",
        path: ["metric"],
      });
    }
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

/**
 * Sujetos posibles de una meta (0051). El sujeto dice DE QUIÉN es la meta;
 * la métrica dice QUÉ se le mide.
 */
export const GOAL_SUBJECTS = ["team", "advisor", "organic"] as const;
export type GoalSubject = (typeof GOAL_SUBJECTS)[number];

export const GOAL_SUBJECT_LABELS: Record<GoalSubject, string> = {
  team: "Equipo (toda la organización)",
  advisor: "Vendedor",
  organic: "Venta orgánica (tienda online)",
};

/**
 * Métricas admisibles por sujeto.
 *
 * La venta orgánica solo admite `amount`: entra sola por la tienda online, sin
 * cotización enviada ni oportunidad trabajada, así que `quotes` y `won` no
 * tienen significado para ella — una meta así marcaría cero siempre. El mismo
 * invariante está en la migración 0051 como CHECK (`goals_organic_amount_only`);
 * aquí evita ofrecer en la UI una opción que la BD va a rechazar.
 */
export function metricsForSubject(subject: GoalSubject): readonly GoalMetric[] {
  return subject === "organic" ? (["amount"] as const) : GOAL_METRICS;
}

/** ¿El sujeto apunta a una persona concreta? (exige membership). */
export function subjectNeedsAdvisor(subject: GoalSubject): boolean {
  return subject === "advisor";
}
