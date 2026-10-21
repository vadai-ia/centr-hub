import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sheetName, FUNNEL_LABELS } from "@/lib/export/pipeline-export";

/**
 * Exportación del tablero a Excel.
 *
 * El nombre de hoja no es cosmético: Excel lo limita a 31 caracteres,
 * prohíbe `: \ / ? * [ ]` y no admite dos hojas con el mismo nombre. Un
 * nombre inválido NO da un error legible — revienta al escribir el libro, y
 * el usuario solo ve que "el botón no hace nada". Los nombres de etapa los
 * edita el admin, así que cualquiera de los tres casos puede aparecer sin
 * que nadie toque código.
 */

describe("nombre de hoja", () => {
  it("respeta el límite de 31 caracteres de Excel", () => {
    const largo = "Seguimiento para cierre de contrato definitivo";
    const n = sheetName(largo, new Set());
    expect(n.length).toBeLessThanOrEqual(31);
  });

  it("quita los caracteres que Excel prohíbe", () => {
    const n = sheetName("Cotización / Revisión [2]", new Set());
    expect(n).not.toMatch(/[:\\/?*[\]]/);
  });

  it("desambigua dos etapas con el MISMO nombre", () => {
    // Caso real: el Outbound de Centr tiene DOS etapas "Lead Nurturing".
    // Sin esto, exceljs falla al añadir la segunda y no se genera nada.
    const usados = new Set<string>();
    const a = sheetName("Lead Nurturing", usados);
    const b = sheetName("Lead Nurturing", usados);
    expect(a).toBe("Lead Nurturing");
    expect(b).not.toBe(a);
    expect(b.length).toBeLessThanOrEqual(31);
  });

  it("desambigua también cuando el nombre ya venía recortado", () => {
    const usados = new Set<string>();
    const largo = "Etapa con un nombre larguísimo que no cabe";
    const a = sheetName(largo, usados);
    const b = sheetName(largo, usados);
    expect(a).not.toBe(b);
    expect(b.length).toBeLessThanOrEqual(31);
  });

  it("un nombre vacío no produce una hoja sin nombre", () => {
    expect(sheetName("   ", new Set()).length).toBeGreaterThan(0);
  });

  it("no colisiona con la hoja de Resumen", () => {
    // El resumen se añade primero y siembra el set; una etapa llamada
    // "Resumen" tiene que ceder, no pisar la portada.
    const usados = new Set<string>(["Resumen"]);
    expect(sheetName("Resumen", usados)).not.toBe("Resumen");
  });
});

describe("el recorte por rol vive en el servidor", () => {
  const action = readFileSync(
    path.resolve(__dirname, "..", "lib/actions/pipeline-export.ts"),
    "utf8",
  );

  it("un vendedor solo exporta lo suyo, ignorando el input", () => {
    // Si el recorte viviera en la UI, bastaría llamar la action a mano para
    // bajarse el pipeline completo de la organización.
    expect(action).toContain("canSeeAllData");
    expect(action).toContain("effectiveAdvisorId = membership.id");
  });

  it("Outbound sigue vedado a quien no ve toda la organización", () => {
    expect(action).toContain('input.funnel === "outbound" && !isAdmin');
    expect(action).toContain("forbidden_funnel");
  });

  it("aplica las MISMAS reglas de visibilidad que el tablero", () => {
    // Un archivo que trae lo que la pantalla oculta es la queja "la data no
    // coincide" servida en bandeja.
    expect(action).toContain("closedFilterForStage");
    expect(action).toContain("minEffectiveIso");
  });
});

describe("etiquetas de funnel", () => {
  it("cubre los tres tableros", () => {
    expect(Object.keys(FUNNEL_LABELS).sort()).toEqual(
      ["outbound", "post_venta", "venta"].sort(),
    );
  });
});
