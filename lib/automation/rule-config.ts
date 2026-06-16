import { z } from "zod";
import type { RuleTriggerType } from "@/lib/types/database";

/**
 * Contrato de configuración de reglas de automatización (M1v2).
 *
 * Los JSONB `trigger_config`, `conditions` y `actions` de
 * `automation_rules` no tienen forma forzada en SQL (3.3.6). Este módulo
 * es la fuente única de su forma: Zod los valida en el motor (al evaluar)
 * y en las server actions del admin (al crear/editar). Compartido
 * cliente+servidor (NO `server-only`) para que el form del admin reuse
 * los mismos tipos y el describidor en lenguaje claro.
 *
 * V2 — alcance cerrado (decisión del operador, M1v2):
 *   - Triggers SOPORTADOS: stage_aging, no_activity, contact.no_activity
 *     (evaluación periódica por cron). Los triggers de evento existen en
 *     el schema pero quedan LATENTES (no cableados) en este milestone.
 *   - Acciones PERMITIDAS: create_task, notify_advisor, notify_admin.
 *   - Acciones PROHIBIDAS: cualquiera que MODIFIQUE la oportunidad
 *     (move_to_stage, add_tag, assign_*). El motor las rechaza aunque
 *     una regla llegara a tenerlas (defensa en profundidad).
 */

// ------------------------------------------------------------
// Triggers
// ------------------------------------------------------------

/** Triggers de tiempo evaluados por el cron horario (los únicos activos en V2). */
export const TIME_TRIGGER_TYPES = [
  "stage_aging",
  "no_activity",
  "contact.no_activity",
] as const;
export type TimeTriggerType = (typeof TIME_TRIGGER_TYPES)[number];

export function isTimeTrigger(t: RuleTriggerType): t is TimeTriggerType {
  return (TIME_TRIGGER_TYPES as readonly string[]).includes(t);
}

// ------------------------------------------------------------
// Acciones
// ------------------------------------------------------------

export const ALLOWED_ACTION_TYPES = [
  "create_task",
  "notify_advisor",
  "notify_admin",
] as const;
export type AllowedActionType = (typeof ALLOWED_ACTION_TYPES)[number];

/** Acciones que modifican la oportunidad — prohibidas en V2 por riesgo. */
export const FORBIDDEN_ACTION_TYPES = [
  "move_to_stage",
  "add_tag",
  "assign_to_advisor",
  "assign_to_vendor",
  "assign",
] as const;

export const createTaskActionSchema = z.object({
  type: z.literal("create_task"),
  task_type: z.string().trim().min(1).max(40).default("follow_up"),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).nullable().optional(),
});

export const notifyAdvisorActionSchema = z.object({
  type: z.literal("notify_advisor"),
  title: z.string().trim().min(1).max(160).optional(),
  message: z.string().trim().max(500).optional(),
});

export const notifyAdminActionSchema = z.object({
  type: z.literal("notify_admin"),
  title: z.string().trim().min(1).max(160).optional(),
  message: z.string().trim().max(500).optional(),
});

export const ruleActionSchema = z.discriminatedUnion("type", [
  createTaskActionSchema,
  notifyAdvisorActionSchema,
  notifyAdminActionSchema,
]);
export type RuleAction = z.infer<typeof ruleActionSchema>;

/** Lista de acciones — al menos una; solo tipos permitidos. */
export const ruleActionsSchema = z.array(ruleActionSchema).min(1).max(5);

// ------------------------------------------------------------
// Conditions (subset usado por las semillas)
// ------------------------------------------------------------

export const ruleConditionSchema = z.object({
  field: z.string().trim().min(1).max(60),
  op: z.enum(["gte", "lte", "eq"]),
  value: z.number(),
});
export type RuleCondition = z.infer<typeof ruleConditionSchema>;
export const ruleConditionsSchema = z.array(ruleConditionSchema).max(10);

// ------------------------------------------------------------
// trigger_config por tipo
// ------------------------------------------------------------

export const stageAgingConfigSchema = z
  .object({
    stage_name: z.string().trim().min(1).max(80),
    hours_in_stage: z.number().int().positive().max(8760).optional(),
    days_in_stage: z.number().int().positive().max(365).optional(),
  })
  .refine((c) => c.hours_in_stage != null || c.days_in_stage != null, {
    message: "Define horas o días en etapa",
  });
export type StageAgingConfig = z.infer<typeof stageAgingConfigSchema>;

export const noActivityConfigSchema = z
  .object({
    hours_without_activity: z.number().int().positive().max(8760).optional(),
    days_without_activity: z.number().int().positive().max(365).optional(),
    exclude_terminal_stages: z.boolean().optional(),
    restricted_to_stage: z.string().trim().min(1).max(80).optional(),
  })
  .refine(
    (c) => c.hours_without_activity != null || c.days_without_activity != null,
    { message: "Define horas o días sin actividad" },
  );
export type NoActivityConfig = z.infer<typeof noActivityConfigSchema>;

export const contactNoActivityConfigSchema = z
  .object({
    hours_without_activity: z.number().int().positive().max(8760).optional(),
    days_without_activity: z.number().int().positive().max(365).optional(),
  })
  .refine(
    (c) => c.hours_without_activity != null || c.days_without_activity != null,
    { message: "Define horas o días sin actividad" },
  );
export type ContactNoActivityConfig = z.infer<
  typeof contactNoActivityConfigSchema
>;

/** Normaliza un trigger_config de tiempo a horas-umbral. */
export function thresholdHoursFromConfig(cfg: {
  hours_in_stage?: number;
  days_in_stage?: number;
  hours_without_activity?: number;
  days_without_activity?: number;
}): number | null {
  if (cfg.hours_in_stage != null) return cfg.hours_in_stage;
  if (cfg.days_in_stage != null) return cfg.days_in_stage * 24;
  if (cfg.hours_without_activity != null) return cfg.hours_without_activity;
  if (cfg.days_without_activity != null) return cfg.days_without_activity * 24;
  return null;
}

/**
 * Ventana de cooldown de re-insistencia para `create_task`: una tarea de
 * regla completada se vuelve a crear solo tras un período COMPLETO del
 * propio umbral de la regla desde que se completó (no al tick siguiente).
 * Devuelve el ISO de corte (`now - thresholdHours`): si la última tarea de
 * la regla para el sujeto se completó EN/DESPUÉS de ese corte, todavía no
 * se reinsiste. `null` si la regla no tiene umbral de tiempo (sin cooldown).
 * Cada regla insiste a SU ritmo — el valor no es fijo, sale de su umbral.
 */
export function reinsistCooldownSinceIso(
  nowMs: number,
  thresholdHours: number | null,
): string | null {
  if (thresholdHours == null) return null;
  return new Date(nowMs - thresholdHours * 3_600_000).toISOString();
}

// ------------------------------------------------------------
// Descripción en lenguaje claro (admin UI)
// ------------------------------------------------------------

function humanThreshold(hours?: number, days?: number): string {
  if (days != null) return `${days} día${days === 1 ? "" : "s"}`;
  if (hours != null) return `${hours} hora${hours === 1 ? "" : "s"}`;
  return "—";
}

export function describeActionType(type: string): string {
  switch (type) {
    case "create_task":
      return "Crear tarea";
    case "notify_advisor":
      return "Avisar al asesor";
    case "notify_admin":
      return "Avisar al admin";
    default:
      return type;
  }
}

/**
 * Frase legible de la condición/disparador de una regla, para listarla
 * en la pantalla del admin sin exponer JSON.
 */
export function describeTrigger(
  triggerType: RuleTriggerType,
  rawConfig: unknown,
): string {
  const cfg = (rawConfig ?? {}) as Record<string, number | string | boolean>;
  switch (triggerType) {
    case "stage_aging":
      return `Cuando una oportunidad lleva ${humanThreshold(
        cfg.hours_in_stage as number | undefined,
        cfg.days_in_stage as number | undefined,
      )} en la etapa "${cfg.stage_name ?? "—"}"`;
    case "no_activity": {
      const scope = cfg.restricted_to_stage
        ? ` en la etapa "${cfg.restricted_to_stage}"`
        : "";
      return `Cuando una oportunidad${scope} no tiene actividad por ${humanThreshold(
        cfg.hours_without_activity as number | undefined,
        cfg.days_without_activity as number | undefined,
      )}`;
    }
    case "contact.no_activity":
      return `Cuando un contacto no tiene actividad por ${humanThreshold(
        cfg.hours_without_activity as number | undefined,
        cfg.days_without_activity as number | undefined,
      )}`;
    default:
      return triggerType;
  }
}
