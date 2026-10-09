import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TASK_REMINDER_NOTIFICATION_TYPE } from "@/lib/constants";

/**
 * Guard estático del cableado de los recordatorios de tareas (punto 13).
 *
 * Los tres fallos que protege comparten una propiedad peligrosa: son
 * SILENCIOSOS. Nada truena, ninguna pantalla se rompe, `tsc` está contento —
 * simplemente los avisos dejan de salir, o dejan de apagarse.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.resolve(ROOT, rel), "utf8");

describe("cableado: el cron de recordatorios está registrado", () => {
  it("aparece en allFunctions", () => {
    // Un cron que no está en el registro no se sirve en /api/inngest y por
    // tanto nunca corre. El síntoma es "no llegan los avisos".
    const index = read("lib/inngest/functions/index.ts");
    expect(index).toContain('from "./task-reminder-cron"');
    expect(index).toContain("...taskReminderFunctions,");
  });

  it("el cron lee la hora y la zona de CADA organización", () => {
    // La expresión cron está en horario de México: sin esto, una tienda en
    // otro huso recibe su aviso a una hora corrida.
    const cron = read("lib/inngest/functions/task-reminder-cron.ts");
    expect(cron).toContain("readOrganizationTimezone");
    expect(cron).toContain("readOrganizationTaskReminderHour");
  });

  it("el cron se calla durante el backfill", () => {
    // Importar el histórico puede traer tareas con fechas viejas; el primer
    // tick las convertiría todas en avisos.
    const cron = read("lib/inngest/functions/task-reminder-cron.ts");
    expect(cron).toContain("backfill_in_progress");
  });

  it("no choca de minuto con los otros crons que recorren todas las orgs", () => {
    const minuteOf = (rel: string) =>
      /cron:\s*"TZ=[^"]*?\s(\d+)\s/.exec(read(rel))?.[1];
    const propio = minuteOf("lib/inngest/functions/task-reminder-cron.ts");
    expect(propio).toBeDefined();
    expect(propio).not.toBe(minuteOf("lib/inngest/functions/rule-evaluation.ts"));
    expect(propio).not.toBe(
      minuteOf("lib/inngest/functions/postventa-followup-cron.ts"),
    );
  });
});

describe("cableado: el recordatorio se apaga cuando la tarea se cierra", () => {
  const actions = read("lib/actions/opportunities-m6.ts");

  it("al marcar la tarea como completada", () => {
    // Si no, el aviso sigue en la campanita tras completar — y una campanita
    // que miente es una campanita que se ignora.
    expect(actions).toContain("closeOpenRemindersForTask");
    const toggle = actions.slice(
      actions.indexOf("export async function toggleTaskCompletedAction"),
      actions.indexOf("export async function editTaskAction"),
    );
    expect(toggle).toContain("closeOpenRemindersForTask");
  });

  it("y al borrar la tarea", () => {
    // El aviso cuelga de `origin_reference.task_id`, NO de una FK: borrar la
    // tarea no se lo lleva, y quedaría insistiendo por algo que ya no existe
    // y que nadie puede marcar.
    const del = actions.slice(
      actions.indexOf("export async function deleteTaskAction"),
    );
    expect(del).toContain("closeOpenRemindersForTask");
  });
});

describe("cableado: el tipo de aviso es UNA constante, no un literal suelto", () => {
  it("quien crea, quien cierra y quien lee usan la misma constante", () => {
    // El vínculo aviso ↔ tarea es ese string. Escribirlo a mano en un solo
    // lado deja recordatorios que nadie vuelve a encontrar ni a cerrar.
    for (const file of [
      "lib/services/task-reminder-run.ts",
      "lib/db/task-reminders.ts",
    ]) {
      const src = read(file);
      expect(src).toContain("TASK_REMINDER_NOTIFICATION_TYPE");
      expect(src).not.toContain(`"${TASK_REMINDER_NOTIFICATION_TYPE}"`);
    }
  });

  it("el enlace con la tarea viaja en origin_reference.task_id", () => {
    expect(read("lib/services/task-reminder-run.ts")).toContain("task_id:");
    expect(read("lib/db/task-reminders.ts")).toContain("task_id");
  });
});
