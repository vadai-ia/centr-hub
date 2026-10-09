import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatLastSeen,
  groupSessionsByDay,
  isOnline,
} from "@/lib/services/presence-display";
import {
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_ONLINE_WINDOW_MINUTES,
  PRESENCE_SESSION_GAP_MINUTES,
} from "@/lib/constants";

/**
 * Presentación de la presencia (0057). Módulo puro — el "ahora" entra como
 * parámetro, así que no hay relojes que fingir.
 */

const MX = "America/Mexico_City";
const CO = "America/Bogota";

describe("isOnline", () => {
  const now = "2026-10-09T18:00:00.000Z";

  it("un latido reciente cuenta como en línea", () => {
    expect(isOnline("2026-10-09T17:58:00.000Z", now)).toBe(true);
  });

  it("fuera de la ventana ya no", () => {
    expect(isOnline("2026-10-09T17:50:00.000Z", now)).toBe(false);
  });

  it("sin ningún latido no está en línea", () => {
    expect(isOnline(null, now)).toBe(false);
  });

  it("un latido en el futuro (reloj adelantado) cuenta como en línea", () => {
    // Decir "sin actividad" de alguien que acaba de latir es peor error que
    // creerle al reloj.
    expect(isOnline("2026-10-09T18:03:00.000Z", now)).toBe(true);
  });

  it("una fecha inválida no truena ni miente", () => {
    expect(isOnline("no-es-fecha", now)).toBe(false);
  });
});

describe("la ventana de en línea es más ancha que el latido", () => {
  it("si no, la persona parpadearía entre latido y latido", () => {
    // Este es el invariante que hace usable el indicador: con una ventana
    // igual o menor al intervalo, cada hueco normal entre latidos se leería
    // como "se desconectó".
    expect(PRESENCE_ONLINE_WINDOW_MINUTES * 60_000).toBeGreaterThan(
      PRESENCE_HEARTBEAT_MS,
    );
  });

  it("y el corte de tramo es más ancho todavía", () => {
    // Un par de latidos perdidos no debe partir en dos una sola sesión.
    expect(PRESENCE_SESSION_GAP_MINUTES).toBeGreaterThan(
      PRESENCE_ONLINE_WINDOW_MINUTES,
    );
  });
});

describe("formatLastSeen", () => {
  const now = "2026-10-09T18:00:00.000Z"; // 12:00 en CDMX

  it("en línea cuando acaba de latir", () => {
    expect(formatLastSeen("2026-10-09T17:59:00.000Z", now, MX)).toBe("En línea");
  });

  it("minutos cuando es de hace un rato", () => {
    expect(formatLastSeen("2026-10-09T17:30:00.000Z", now, MX)).toBe("hace 30 min");
  });

  it("hora del mismo día cuando ya pasaron horas", () => {
    expect(formatLastSeen("2026-10-09T13:00:00.000Z", now, MX)).toBe("hoy 07:00");
  });

  it("ayer con su hora", () => {
    expect(formatLastSeen("2026-10-08T16:00:00.000Z", now, MX)).toBe("ayer 10:00");
  });

  it("sin latidos dice que no hay actividad, no que nunca entró", () => {
    // "Nunca entró" lo dice el badge de login; esto es otra cosa.
    expect(formatLastSeen(null, now, MX)).toBe("Sin actividad");
  });

  it("la zona de la organización decide el día", () => {
    // 05:30 UTC = 23:30 del día 8 en CDMX, pero 00:30 del día 9 en Bogotá.
    const lastSeen = "2026-10-09T05:30:00.000Z";
    expect(formatLastSeen(lastSeen, now, MX)).toBe("ayer 23:30");
    expect(formatLastSeen(lastSeen, now, CO)).toBe("hoy 00:30");
  });
});

describe("formatDuration", () => {
  it("minutos solos", () => {
    expect(formatDuration(35)).toBe("35 min");
  });
  it("horas y minutos", () => {
    expect(formatDuration(268)).toBe("4 h 28 min");
  });
  it("horas exactas", () => {
    expect(formatDuration(120)).toBe("2 h");
  });
  it("un tramo de un solo latido no dice '0 min'", () => {
    expect(formatDuration(0)).toBe("menos de 1 min");
  });
});

describe("groupSessionsByDay", () => {
  const now = "2026-10-09T18:00:00.000Z";

  it("agrupa por día, suma el día y ordena del más reciente", () => {
    const days = groupSessionsByDay(
      [
        {
          id: "s3",
          startedAt: "2026-10-09T15:10:00.000Z",
          lastSeenAt: "2026-10-09T17:00:00.000Z",
        },
        {
          id: "s2",
          startedAt: "2026-10-09T13:00:00.000Z",
          lastSeenAt: "2026-10-09T14:00:00.000Z",
        },
        {
          id: "s1",
          startedAt: "2026-10-08T15:00:00.000Z",
          lastSeenAt: "2026-10-08T16:30:00.000Z",
        },
      ],
      now,
      MX,
    );
    expect(days.map((d) => d.label)).toEqual(["Hoy", "Ayer"]);
    expect(days[0]?.sessions.map((s) => s.id)).toEqual(["s3", "s2"]);
    expect(days[0]?.sessions[0]?.from).toBe("09:10");
    expect(days[0]?.sessions[0]?.to).toBe("11:00");
    expect(days[0]?.total).toBe("2 h 50 min");
    expect(days[1]?.total).toBe("1 h 30 min");
  });

  it("el tramo vigente se marca como en curso", () => {
    const days = groupSessionsByDay(
      [
        {
          id: "s1",
          startedAt: "2026-10-09T17:00:00.000Z",
          lastSeenAt: "2026-10-09T17:59:00.000Z",
        },
      ],
      now,
      MX,
    );
    expect(days[0]?.sessions[0]?.ongoing).toBe(true);
  });

  it("un tramo que cruza la medianoche se reporta en el día en que EMPEZÓ", () => {
    // Es como lo cuenta quien trabajó: "me quedé hasta la una".
    const days = groupSessionsByDay(
      [
        {
          id: "s1",
          // 22:00 del 8 en CDMX → 01:00 del 9.
          startedAt: "2026-10-09T04:00:00.000Z",
          lastSeenAt: "2026-10-09T07:00:00.000Z",
        },
      ],
      now,
      MX,
    );
    expect(days).toHaveLength(1);
    expect(days[0]?.label).toBe("Ayer");
    expect(days[0]?.sessions[0]?.from).toBe("22:00");
    expect(days[0]?.sessions[0]?.to).toBe("01:00");
  });

  it("la zona de la organización mueve el día del tramo", () => {
    const sessions = [
      {
        id: "s1",
        // 05:30 UTC = 23:30 del 8 en CDMX, pero 00:30 del 9 en Bogotá.
        startedAt: "2026-10-09T05:30:00.000Z",
        lastSeenAt: "2026-10-09T06:00:00.000Z",
      },
    ];
    expect(groupSessionsByDay(sessions, now, MX)[0]?.label).toBe("Ayer");
    expect(groupSessionsByDay(sessions, now, CO)[0]?.label).toBe("Hoy");
  });

  it("sin tramos devuelve lista vacía, no un día en blanco", () => {
    expect(groupSessionsByDay([], now, MX)).toEqual([]);
  });
});
