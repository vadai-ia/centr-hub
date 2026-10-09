import { DEFAULT_TASK_REMINDER_HOUR } from "@/lib/constants";
import type { Json } from "@/lib/types/database";

/**
 * "Primera hora" de la organización — `organizations.config.defaults.task_reminder_hour`.
 *
 * Mismo patrón que la moneda y la zona horaria: la hora a la que arranca el
 * día de trabajo no es la misma en todas las tiendas, y cambiarla tiene que
 * ser un UPDATE, no un deploy.
 *
 * Valida 0–23 ENTERO. Un valor basura (texto, 25, 8.5) desplazaría el aviso
 * a una hora que nunca llega, y el síntoma sería "los recordatorios no
 * salen" — sin ningún error que lo delate. Fuera de rango vuelve al default.
 *
 * NO es `server-only`: función pura.
 */
export function readOrganizationTaskReminderHour(
  config: Json | null | undefined,
): number {
  let raw: unknown;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const defaults = (config as Record<string, unknown>).defaults;
    if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
      raw = (defaults as Record<string, unknown>).task_reminder_hour;
    }
  }
  const hour = typeof raw === "string" ? Number(raw) : raw;
  if (typeof hour !== "number" || !Number.isInteger(hour)) {
    return DEFAULT_TASK_REMINDER_HOUR;
  }
  if (hour < 0 || hour > 23) return DEFAULT_TASK_REMINDER_HOUR;
  return hour;
}
