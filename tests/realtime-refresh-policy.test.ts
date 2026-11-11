import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  planBurstFlush,
  shouldBackgroundRefresh,
  type RefreshState,
} from "@/lib/services/realtime-refresh-policy";
import {
  PIPELINE_POLLING_FALLBACK_MS,
  REALTIME_BURST_FULL_RELOAD_THRESHOLD,
  REALTIME_POLL_CHECK_MS,
  REALTIME_SAFETY_POLL_MS,
} from "@/lib/constants";

/**
 * Recarga de fondo adaptativa. Contexto: la recarga completa cada 30 s
 * incondicional agotó el CPU de Vercel y pausó el proyecto. Estas pruebas
 * fijan que la red de seguridad sigue existiendo pero ya no se paga cuando
 * nadie mira ni cuando Realtime funciona.
 */

const base: RefreshState = {
  hidden: false,
  connected: true,
  msSinceLastRefresh: 0,
  dirty: false,
};

describe("shouldBackgroundRefresh", () => {
  it("pestaña oculta: nunca, ni con Realtime caído ni con cambios pendientes", () => {
    for (const trigger of ["tick", "visible"] as const) {
      expect(
        shouldBackgroundRefresh(trigger, {
          hidden: true,
          connected: false,
          msSinceLastRefresh: 60 * 60_000,
          dirty: true,
        }),
      ).toBe(false);
    }
  });

  it("Realtime conectado: solo la red de seguridad de 5 min", () => {
    expect(
      shouldBackgroundRefresh("tick", { ...base, msSinceLastRefresh: PIPELINE_POLLING_FALLBACK_MS }),
    ).toBe(false);
    expect(
      shouldBackgroundRefresh("tick", { ...base, msSinceLastRefresh: REALTIME_SAFETY_POLL_MS }),
    ).toBe(true);
  });

  it("Realtime caído: vuelve al ritmo de 30 s", () => {
    const off = { ...base, connected: false };
    expect(shouldBackgroundRefresh("tick", { ...off, msSinceLastRefresh: 10_000 })).toBe(false);
    expect(
      shouldBackgroundRefresh("tick", { ...off, msSinceLastRefresh: PIPELINE_POLLING_FALLBACK_MS }),
    ).toBe(true);
  });

  it("al volver a la pestaña con cambios pendientes recarga en el acto", () => {
    expect(shouldBackgroundRefresh("visible", { ...base, dirty: true })).toBe(true);
  });

  it("al volver tras un rato fuera recarga; un ida y vuelta rápido no", () => {
    expect(shouldBackgroundRefresh("visible", { ...base, msSinceLastRefresh: 5_000 })).toBe(false);
    expect(
      shouldBackgroundRefresh("visible", { ...base, msSinceLastRefresh: PIPELINE_POLLING_FALLBACK_MS }),
    ).toBe(true);
  });

  it("los periodos están escalonados: el chequeo es más fino que lo que vigila", () => {
    expect(REALTIME_POLL_CHECK_MS).toBeLessThan(PIPELINE_POLLING_FALLBACK_MS);
    expect(PIPELINE_POLLING_FALLBACK_MS).toBeLessThan(REALTIME_SAFETY_POLL_MS);
  });
});

describe("planBurstFlush", () => {
  it("nada, tarjeta por tarjeta, o una recarga completa", () => {
    expect(planBurstFlush(0)).toBe("none");
    expect(planBurstFlush(1)).toBe("per_item");
    expect(planBurstFlush(REALTIME_BURST_FULL_RELOAD_THRESHOLD - 1)).toBe("per_item");
    expect(planBurstFlush(REALTIME_BURST_FULL_RELOAD_THRESHOLD)).toBe("full_reload");
  });
});

/**
 * Guard de cableado: el refresco incondicional era un `setInterval` con
 * `PIPELINE_POLLING_FALLBACK_MS` dentro de los hooks de Realtime. Volver a
 * ponerlo es invisible para `tsc` y para la suite, y el síntoma es una
 * factura (o un proyecto pausado), no un error.
 */
describe("hooks de Realtime usan la recarga adaptativa", () => {
  const hooks = [
    "app/(dashboard)/pipeline/use-pipeline-realtime.ts",
    "app/(dashboard)/mi-dia/use-mi-dia-realtime.ts",
  ];
  for (const rel of hooks) {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    it(`${rel}: sin polling incondicional`, () => {
      expect(src).not.toMatch(/setInterval\s*\(/);
      expect(src).not.toMatch(/PIPELINE_POLLING_FALLBACK_MS/);
    });
    it(`${rel}: cableado a useBackgroundRefresh y a la pestaña oculta`, () => {
      expect(src).toMatch(/useBackgroundRefresh\(/);
      expect(src).toMatch(/isDocumentHidden\(\)/);
      expect(src).toMatch(/connectedRef\.current = true/);
    });
  }
});
