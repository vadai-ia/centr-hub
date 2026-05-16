import "server-only";
import { requireTenantContext } from "@/lib/tenant/context";
import type {
  AutomationRuleRow,
  ContactRow,
  OpportunityRow,
  RuleExecutionStatus,
  Json,
} from "@/lib/types/database";

/**
 * Motor de reglas (Sección 3.3.6 + 4.5).
 *
 * Stub para M1 — la implementación viva en M8. Conceptos clave
 * que la implementación debe respetar:
 *
 *   - Triggers de evento (`created`, `stage_changed`, `won`, `lost`,
 *     `contact.created`) se evalúan EN LÍNEA cuando el evento ocurre.
 *   - Triggers de tiempo (`stage_aging`, `no_activity`,
 *     `contact.no_activity`) se evalúan en jobs periódicos
 *     cada hora (Inngest cron).
 *   - Circuit breaker: regla que excede N ejecuciones por hora se
 *     desactiva automáticamente con alerta admin.
 *   - Idempotencia (R4): la misma regla evaluando la misma oportunidad
 *     en dos ciclos seguidos NO debe producir acción duplicada.
 *   - Acciones permitidas: create_task, notify_advisor, notify_admin,
 *     move_to_stage, add_tag.
 *   - Acciones NO permitidas en MVP: assign_to_advisor (decisión
 *     cerrada Research v6), send_template_message, send_freeform_message.
 */

export interface EvaluateRuleInput {
  rule: AutomationRuleRow;
  opportunity?: OpportunityRow;
  contact?: ContactRow;
  /** Fuente disparadora del evento (en triggers de evento). */
  eventType?:
    | "created"
    | "stage_changed"
    | "won"
    | "lost"
    | "contact.created"
    | "tick_hourly"; // los triggers de tiempo se invocan con tick
}

export interface RuleEvaluationOutcome {
  status: RuleExecutionStatus;
  actionsTaken: Array<{ type: string; result: Json }>;
  skipReason?: string;
  failureReason?: string;
}

export async function evaluateRule(_input: EvaluateRuleInput): Promise<RuleEvaluationOutcome> {
  requireTenantContext();
  throw new Error("rules-engine: implementación pendiente (M8)");
}

/**
 * Tick horario disparado desde Inngest cron.
 *   - Evalúa reglas con triggers de tiempo (stage_aging, no_activity).
 *   - Reactiva tareas / notificaciones snoozeadas que cumplieron
 *     su `snoozed_until` (Sección 3.3.7 + CLAUDE.md timezone).
 */
export async function tickHourly(): Promise<void> {
  requireTenantContext();
  throw new Error("rules-engine.tickHourly: implementación pendiente (M8)");
}
