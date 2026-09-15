import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard: toda métrica de venta se mide por SUBTOTAL (productos con descuentos,
 * sin envío), nunca por `total_amount`, que suma el envío. Volver a leer el
 * total es invisible para `tsc` si alguien re-agrega la columna al select, así
 * que se asierta sobre el código fuente. Ver ERRORES.md ("La venta se mide por
 * subtotal").
 */
const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("la venta se mide por subtotal", () => {
  it.each(["lib/db/dashboard.ts", "lib/services/dashboard-metrics.ts", "lib/db/orders.ts"])(
    "%s no suma total_amount",
    (file) => {
      expect(src(file)).not.toMatch(/total_amount/);
    },
  );

  it("el monto de la oportunidad nace del subtotal de la cotización", () => {
    const worker = src("lib/inngest/functions/draft-orders.ts");
    expect(worker).not.toMatch(/actual_amount:\s*[\w.]*\btotalAmount/);
    expect(worker).toMatch(/actual_amount:\s*[\w.]*subtotalAmount/);
  });

  it("la opp de compra online nace del subtotal del pedido", () => {
    expect(src("lib/services/online-order-opportunity.ts")).toMatch(/actual_amount:\s*order\.subtotal/);
  });
});
