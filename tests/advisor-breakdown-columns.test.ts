import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * El desglose por vendedor se pinta en DOS sitios: la tabla del Dashboard y
 * la exportación. El código ya se exige que coincidan —"un reporte que dice
 * otra cosa que el tablero confunde justo a quien lo presenta"— pero esa
 * exigencia vivía solo en un comentario: agregar una columna en pantalla y
 * olvidarla en el export no rompe nada visible hasta que alguien compara el
 * PDF con el tablero en una junta.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.resolve(ROOT, rel), "utf8");

const pantalla = read("app/(dashboard)/dashboard/advisor-breakdown.tsx");
const exportacion = read("lib/export/dashboard-export.ts");

/** Las etiquetas del `columns: [...]` del desglose de Venta en la exportación. */
function columnasDelExport(): string[] {
  const i = exportacion.indexOf('heading: "Venta · Desglose por vendedor"');
  expect(i, "no se encontró el desglose de Venta en la exportación").toBeGreaterThan(0);
  const desde = exportacion.indexOf("columns: [", i);
  const hasta = exportacion.indexOf("]", desde);
  expect(desde).toBeGreaterThan(0);
  return exportacion
    .slice(desde + "columns: [".length, hasta)
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

describe("el desglose por vendedor dice lo mismo en pantalla y en el reporte", () => {
  it("toda columna de la exportación existe en la tabla", () => {
    for (const col of columnasDelExport()) {
      expect(
        pantalla.includes(`>${col}<`) || pantalla.includes(`${col}\n`) || pantalla.includes(col),
        `la exportación tiene la columna "${col}" y la tabla del Dashboard no`,
      ).toBe(true);
    }
  });

  it("el número de columnas coincide con el de celdas por fila", () => {
    // Una columna añadida al encabezado sin su celda corre todos los valores
    // una posición: el reporte se lee bien y dice otra cosa.
    const cols = columnasDelExport();
    const i = exportacion.indexOf('heading: "Venta · Desglose por vendedor"');
    const desde = exportacion.indexOf("rows: data.ventaBreakdown.map((r) => [", i);
    const hasta = exportacion.indexOf("]),", desde);
    const celdas = exportacion
      .slice(desde, hasta)
      .split("\n")
      .filter((l) => /^\s+(r\.|format)/.test(l));
    expect(celdas).toHaveLength(cols.length);
  });

  it("la columna de Leads está en los dos", () => {
    expect(columnasDelExport()).toContain("Leads");
    expect(pantalla).toContain("r.leads");
  });
});
