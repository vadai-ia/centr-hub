import { describe, expect, it } from "vitest";
import { readOrganizationTimezone } from "@/lib/services/organization-timezone";
import {
  monthKeyInTz,
  previousMonthDateKey,
  resolveCustomPeriod,
  resolveMonthPeriod,
} from "@/lib/time/period";
import { TIMEZONE } from "@/lib/constants";

/**
 * Zona horaria POR ORGANIZACIÓN.
 *
 * El invariante que más importa no es que Colombia corte bien: es que
 * **Centr no se mueva ni un minuto**. Por eso la zona entra como parámetro
 * con default, y estos tests fijan las dos mitades:
 *
 *  1. Sin zona (todo el código existente) → idéntico a antes.
 *  2. Con zona de la tienda → los bordes de día y de mes se desplazan la
 *     hora que corresponde.
 *
 * Bogotá (UTC-5) va una hora ADELANTE de CDMX (UTC-6). Ninguna de las dos
 * usa horario de verano, así que el desfase es constante.
 */

const BOGOTA = "America/Bogota";

describe("readOrganizationTimezone", () => {
  it("lee la zona configurada", () => {
    expect(readOrganizationTimezone({ defaults: { timezone: BOGOTA } })).toBe(BOGOTA);
  });

  it("sin configurar cae a México — las orgs existentes no cambian", () => {
    expect(readOrganizationTimezone(null)).toBe(TIMEZONE);
    expect(readOrganizationTimezone({ defaults: {} })).toBe(TIMEZONE);
  });

  it("una zona inválida NO se propaga: dejaría cada DateTime en invalid", () => {
    expect(readOrganizationTimezone({ defaults: { timezone: "Bogotá" } })).toBe(TIMEZONE);
    expect(readOrganizationTimezone({ defaults: { timezone: "UTC-5" } })).toBe(TIMEZONE);
    expect(readOrganizationTimezone({ defaults: { timezone: 5 } })).toBe(TIMEZONE);
  });
});

describe("los periodos sin zona se comportan EXACTAMENTE como antes", () => {
  it("un mes de México empieza a las 06:00 UTC y termina a las 05:59:59 del siguiente", () => {
    const sept = resolveMonthPeriod("2026-09")!;
    expect(sept.startUtc).toBe("2026-09-01T06:00:00.000Z");
    expect(sept.endUtc).toBe("2026-10-01T05:59:59.999Z");
  });

  it("pasar el default explícitamente da el mismo resultado que omitirlo", () => {
    expect(resolveMonthPeriod("2026-09", TIMEZONE)).toEqual(resolveMonthPeriod("2026-09"));
    expect(resolveCustomPeriod("2026-09-01", "2026-09-30", TIMEZONE)).toEqual(
      resolveCustomPeriod("2026-09-01", "2026-09-30"),
    );
  });
});

describe("con la zona de la tienda los bordes se corren la hora correcta", () => {
  it("el mes de Bogotá abre y cierra una hora antes que el de México", () => {
    const bogota = resolveMonthPeriod("2026-09", BOGOTA)!;
    expect(bogota.startUtc).toBe("2026-09-01T05:00:00.000Z");
    expect(bogota.endUtc).toBe("2026-10-01T04:59:59.999Z");
  });

  it("la venta de las 00:30 del día 1 en Bogotá cae en OCTUBRE, no en septiembre", () => {
    // 2026-10-01 00:30 en Bogotá = 2026-10-01T05:30Z = 2026-09-30 23:30 en CDMX.
    const venta = "2026-10-01T05:30:00.000Z";
    expect(monthKeyInTz(venta)).toBe("2026-09"); // criterio viejo: mes equivocado
    expect(monthKeyInTz(venta, BOGOTA)).toBe("2026-10"); // criterio de la tienda
  });

  it("esa misma venta queda FUERA del mes que congela el snapshot de Colombia", () => {
    const venta = "2026-10-01T05:30:00.000Z";
    const sept = resolveMonthPeriod("2026-09", BOGOTA)!;
    expect(venta > sept.endUtc).toBe(true);
    // Con los límites de México sí habría entrado al snapshot ya inmutable.
    expect(venta < resolveMonthPeriod("2026-09")!.endUtc).toBe(true);
  });

  it("previousMonthDateKey respeta la zona que se le pase", () => {
    // No se fija el valor (depende de la fecha real de ejecución), pero sí
    // que sea el primer día de un mes — el contrato de `period_month`.
    expect(previousMonthDateKey(BOGOTA)).toMatch(/^\d{4}-\d{2}-01$/);
  });
});
