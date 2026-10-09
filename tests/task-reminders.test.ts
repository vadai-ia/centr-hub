import { describe, expect, it } from "vitest";
import {
  decideTaskReminders,
  reminderTitle,
  type ExistingReminder,
  type ReminderTask,
} from "@/lib/services/task-reminders";
import { readOrganizationTaskReminderHour } from "@/lib/services/organization-task-reminder";
import { DEFAULT_TASK_REMINDER_HOUR } from "@/lib/constants";

/**
 * Recordatorios de tareas (punto 13): "aviso el mismo día a primera hora,
 * con un recordatorio que insiste hasta que lo marquen".
 *
 * Todo el comportamiento que importa es temporal, así que el módulo es puro
 * y el "ahora" entra como parámetro.
 */

const MX = "America/Mexico_City";
const CO = "America/Bogota";
const USER = "user-1";

function task(over: Partial<ReminderTask> = {}): ReminderTask {
  return {
    id: "task-1",
    assignedUserId: USER,
    title: "Llamar a Pamela",
    // 2026-10-09 a las 17:00 CDMX.
    dueAt: "2026-10-09T23:00:00.000Z",
    status: "pending",
    opportunityId: "opp-1",
    contactId: "contact-1",
    ...over,
  };
}

function reminder(over: Partial<ExistingReminder> = {}): ExistingReminder {
  return {
    id: "notif-1",
    taskId: "task-1",
    userId: USER,
    isOpen: true,
    createdAt: "2026-10-09T14:00:00.000Z",
    ...over,
  };
}

/** 2026-10-09, 09:00 CDMX — después de la primera hora (8). */
const NOW_9AM = "2026-10-09T15:00:00.000Z";
/** 2026-10-09, 06:00 CDMX — antes de la primera hora. */
const NOW_6AM = "2026-10-09T12:00:00.000Z";

describe("decideTaskReminders — el aviso del mismo día", () => {
  it("avisa de una tarea que vence hoy, pasada la primera hora", () => {
    const plan = decideTaskReminders({
      tasks: [task()],
      reminders: [],
      nowISO: NOW_9AM,
      zone: MX,
      firstHour: 8,
    });
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toCreate[0]?.userId).toBe(USER);
    expect(plan.toCreate[0]?.title).toBe("Tarea para hoy");
    expect(plan.toCreate[0]?.message).toContain("Llamar a Pamela");
    expect(plan.toCreate[0]?.attempt).toBe(1);
  });

  it("NO avisa antes de la primera hora", () => {
    const plan = decideTaskReminders({
      tasks: [task()],
      reminders: [],
      nowISO: NOW_6AM,
      zone: MX,
      firstHour: 8,
    });
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.skipped).toEqual([
      { taskId: "task-1", reason: "before_first_hour" },
    ]);
  });

  it("la primera hora es un PISO, no una ventana: a las 11 también avisa", () => {
    // Una tarea creada para hoy a media mañana no debe esperar a mañana.
    const plan = decideTaskReminders({
      tasks: [task()],
      reminders: [],
      nowISO: "2026-10-09T17:00:00.000Z", // 11:00 CDMX
      zone: MX,
      firstHour: 8,
    });
    expect(plan.toCreate).toHaveLength(1);
  });

  it("NO avisa de una tarea que vence mañana", () => {
    const plan = decideTaskReminders({
      tasks: [task({ dueAt: "2026-10-10T18:00:00.000Z" })],
      reminders: [],
      nowISO: NOW_9AM,
      zone: MX,
      firstHour: 8,
    });
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toBe("not_due_yet");
  });

  it("una tarea sin fecha no genera aviso", () => {
    const plan = decideTaskReminders({
      tasks: [task({ dueAt: null })],
      reminders: [],
      nowISO: NOW_9AM,
      zone: MX,
      firstHour: 8,
    });
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toBe("no_due_date");
  });

  it("la hora de arranque se evalúa en la zona de la ORGANIZACIÓN", () => {
    // 13:00 UTC = 07:00 en CDMX (antes de las 8) pero 08:00 en Bogotá.
    const now = "2026-10-09T13:00:00.000Z";
    const base = { tasks: [task()], reminders: [], nowISO: now, firstHour: 8 };
    expect(decideTaskReminders({ ...base, zone: MX }).toCreate).toHaveLength(0);
    expect(decideTaskReminders({ ...base, zone: CO }).toCreate).toHaveLength(1);
  });
});

describe("decideTaskReminders — insiste hasta que la marquen", () => {
  it("vuelve a avisar de una tarea vencida, con el estado en el título", () => {
    const plan = decideTaskReminders({
      tasks: [task({ dueAt: "2026-10-05T23:00:00.000Z" })],
      reminders: [],
      nowISO: NOW_9AM,
      zone: MX,
      firstHour: 8,
    });
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toCreate[0]?.overdueDays).toBe(4);
    expect(plan.toCreate[0]?.title).toBe("Tarea vencida hace 4 días");
  });

  it("NO duplica mientras el aviso siga abierto en la campanita", () => {
    const plan = decideTaskReminders({
      tasks: [task()],
      reminders: [reminder({ isOpen: true })],
      nowISO: NOW_9AM,
      zone: MX,
      firstHour: 8,
    });
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toClose).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toBe("already_open");
  });

  it("descartarlo sin completar la tarea solo compra la ventana", () => {
    const cerradoHaceRato = reminder({
      isOpen: false,
      createdAt: "2026-10-09T13:00:00.000Z", // 2 h antes del ahora
    });
    expect(
      decideTaskReminders({
        tasks: [task()],
        reminders: [cerradoHaceRato],
        nowISO: NOW_9AM,
        zone: MX,
        firstHour: 8,
        reinsistHours: 24,
      }).skipped[0]?.reason,
    ).toBe("recently_reminded");

    // Pasada la ventana, insiste de nuevo — y cuenta el intento.
    const plan = decideTaskReminders({
      tasks: [task()],
      reminders: [reminder({ isOpen: false, createdAt: "2026-10-08T13:00:00.000Z" })],
      nowISO: NOW_9AM,
      zone: MX,
      firstHour: 8,
      reinsistHours: 24,
    });
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toCreate[0]?.attempt).toBe(2);
  });
});

describe("decideTaskReminders — cerrar lo que ya no corresponde", () => {
  it("cierra el aviso de una tarea que ya no está pendiente", () => {
    // La tarea completada ya no viene en la lista de pendientes.
    const plan = decideTaskReminders({
      tasks: [],
      reminders: [reminder({ isOpen: true })],
      nowISO: NOW_9AM,
      zone: MX,
      firstHour: 8,
    });
    expect(plan.toClose).toEqual([
      { notificationId: "notif-1", reason: "task_not_pending" },
    ]);
    expect(plan.toCreate).toHaveLength(0);
  });

  it("cierra el aviso de una tarea snoozeada (dejó de estar pendiente)", () => {
    const plan = decideTaskReminders({
      tasks: [task({ status: "snoozed" })],
      reminders: [reminder({ isOpen: true })],
      nowISO: NOW_9AM,
      zone: MX,
      firstHour: 8,
    });
    expect(plan.toClose[0]?.reason).toBe("task_not_pending");
    expect(plan.toCreate).toHaveLength(0);
  });

  it("al reasignar la tarea, el aviso pasa al dueño nuevo", () => {
    // El aviso viejo cuelga de alguien que ya no puede hacer nada con él.
    const plan = decideTaskReminders({
      tasks: [task({ assignedUserId: "user-2" })],
      reminders: [reminder({ isOpen: true, userId: USER })],
      nowISO: NOW_9AM,
      zone: MX,
      firstHour: 8,
    });
    expect(plan.toClose).toEqual([
      { notificationId: "notif-1", reason: "reassigned" },
    ]);
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toCreate[0]?.userId).toBe("user-2");
    // Y el aviso que se está cerrando no cuenta como "ya hubo uno": si no,
    // la persona nueva no recibiría nada hasta pasada la ventana.
    expect(plan.toCreate[0]?.attempt).toBe(1);
  });

  it("un aviso ya cerrado no se vuelve a cerrar", () => {
    const plan = decideTaskReminders({
      tasks: [],
      reminders: [reminder({ isOpen: false })],
      nowISO: NOW_9AM,
      zone: MX,
      firstHour: 8,
    });
    expect(plan.toClose).toHaveLength(0);
  });
});

describe("reminderTitle", () => {
  it("distingue hoy, ayer y varios días", () => {
    expect(reminderTitle(0)).toBe("Tarea para hoy");
    expect(reminderTitle(1)).toBe("Tarea vencida ayer");
    expect(reminderTitle(3)).toBe("Tarea vencida hace 3 días");
  });
});

describe("readOrganizationTaskReminderHour", () => {
  it("lee la hora de la organización", () => {
    expect(
      readOrganizationTaskReminderHour({ defaults: { task_reminder_hour: 7 } }),
    ).toBe(7);
  });

  it("acepta la hora escrita como texto", () => {
    expect(
      readOrganizationTaskReminderHour({ defaults: { task_reminder_hour: "9" } }),
    ).toBe(9);
  });

  it("sin configurar usa el default", () => {
    expect(readOrganizationTaskReminderHour(null)).toBe(DEFAULT_TASK_REMINDER_HOUR);
    expect(readOrganizationTaskReminderHour({})).toBe(DEFAULT_TASK_REMINDER_HOUR);
    expect(readOrganizationTaskReminderHour({ defaults: {} })).toBe(
      DEFAULT_TASK_REMINDER_HOUR,
    );
  });

  it("un valor imposible vuelve al default, no desplaza el aviso a nunca", () => {
    for (const malo of [25, -1, 8.5, "ocho", true, null]) {
      expect(
        readOrganizationTaskReminderHour({
          defaults: { task_reminder_hour: malo },
        } as never),
      ).toBe(DEFAULT_TASK_REMINDER_HOUR);
    }
  });

  it("la medianoche es una hora válida, no un valor ausente", () => {
    expect(
      readOrganizationTaskReminderHour({ defaults: { task_reminder_hour: 0 } }),
    ).toBe(0);
  });
});
