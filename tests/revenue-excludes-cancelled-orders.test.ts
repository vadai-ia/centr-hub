import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { recognitionSlices } from "@/lib/services/revenue-recognition";

/**
 * Un pedido CANCELADO no es venta.
 *
 * Shopify permite cancelar un pedido SIN reembolsarlo, y en ese caso
 * `financial_status` se queda en `paid`. Filtrar solo por `financial_status`
 * deja entrar ventas revocadas: medido en Centr, 18 pedidos cancelados
 * sumaban $5,214,312 al KPI de venta (entre ellos uno de $1.88M y el par de
 * un cliente al que se le rehizo el pedido).
 *
 * La regla YA existía en `sumPaidOrdersForContact` (indicadores del contacto)
 * con su comentario R5; lo que faltaba era aplicarla en el Dashboard, las
 * metas de monto y la exportación. Este guard asierta que ninguna consulta de
 * venta vuelva a traer cancelados — es invisible para `tsc` y para la suite
 * mockeada, así que sin él se cuela otra vez.
 */

const ROOT = path.resolve(__dirname, "..");

interface Target {
  file: string;
  fn: string;
  /**
   * Las consultas que alimentan el reconocimiento por anticipo NO filtran por
   * estado: admiten un `pending` con anticipo declarado, y es
   * `recognitionSlices` quien decide. Las demás sí exigen 'paid'.
   */
  filtersPaidStatus: boolean;
}

const REVENUE_QUERIES: Target[] = [
  // KPI de venta, serie por mes, desglose por vendedor y metas de monto.
  { file: "lib/db/dashboard.ts", fn: "listRevenueOrdersInPeriod", filtersPaidStatus: false },
  // Detalle del "¿de dónde sale esta cantidad?" (debe cuadrar con el KPI).
  { file: "lib/db/goal-breakdown.ts", fn: "listPaidOrderDetailsInPeriod", filtersPaidStatus: false },
  // "Leads que compraron".
  { file: "lib/db/dashboard.ts", fn: "listPaidOrdersForContactsSince", filtersPaidStatus: true },
  // Indicadores del contacto: la regla nació aquí.
  { file: "lib/db/orders.ts", fn: "sumPaidOrdersForContact", filtersPaidStatus: true },
  { file: "lib/db/orders.ts", fn: "sumPaidRevenueBetween", filtersPaidStatus: true },
];

function functionBody(file: string, fn: string): string {
  const src = readFileSync(path.join(ROOT, file), "utf8");
  const start = src.indexOf(`export async function ${fn}`);
  expect(start, `no se encontró ${fn} en ${file}`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

describe("las consultas de venta excluyen pedidos cancelados", () => {
  for (const { file, fn, filtersPaidStatus } of REVENUE_QUERIES) {
    it(`${fn} (${file}) filtra cancelled_at`, () => {
      const body = functionBody(file, fn);
      expect(
        body.includes('.is("cancelled_at", null)'),
        `${fn} cuenta pedidos cancelados como venta: Shopify deja ` +
          "financial_status='paid' al cancelar sin reembolso.",
      ).toBe(true);
      if (filtersPaidStatus) {
        expect(
          body.includes('.eq("financial_status", "paid")'),
          `${fn} debería seguir exigiendo pedidos pagados`,
        ).toBe(true);
      }
    });
  }

  it("el reparto por anticipo también descarta cancelados y reembolsos", () => {
    const base = {
      subtotal: "1000",
      paid_at: "2026-07-09T03:06:34.000Z",
      settled_at: "2026-07-09T03:06:34.000Z",
      shopify_tags: ["Anticipo50%"],
    };
    expect(recognitionSlices({ ...base, financial_status: "paid", cancelled_at: null })).toHaveLength(2);
    expect(
      recognitionSlices({ ...base, financial_status: "paid", cancelled_at: "2026-09-08T00:00:00.000Z" }),
    ).toEqual([]);
    expect(recognitionSlices({ ...base, financial_status: "refunded", cancelled_at: null })).toEqual([]);
  });
});
