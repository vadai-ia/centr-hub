import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { filterCardsByName } from "@/lib/services/card-search";

const CARDS = [
  { contactName: "Dave Foran", displayReference: "#D904" },
  { contactName: "Ricardo Rodríguez", displayReference: "#D199" },
  { contactName: "Spininng Center BARRANQUILLA", displayReference: "#D1045" },
  { contactName: null, displayReference: null },
];

describe("buscar una tarjeta por nombre", () => {
  it("ignora acentos y mayúsculas", () => {
    // Nadie teclea "Rodríguez" con tilde al buscar.
    expect(filterCardsByName(CARDS, "rodriguez")).toHaveLength(1);
    expect(filterCardsByName(CARDS, "RODRÍGUEZ")).toHaveLength(1);
    expect(filterCardsByName(CARDS, "BARRANQUILLA")).toHaveLength(1);
  });

  it("busca en cualquier parte, no solo al inicio", () => {
    // La gente teclea el apellido.
    expect(filterCardsByName(CARDS, "foran")).toHaveLength(1);
  });

  it("varias palabras: todas tienen que aparecer, en cualquier orden", () => {
    expect(filterCardsByName(CARDS, "centro barranquilla")).toHaveLength(0);
    expect(filterCardsByName(CARDS, "center barranquilla")).toHaveLength(1);
    expect(filterCardsByName(CARDS, "barranquilla center")).toHaveLength(1);
  });

  it("encuentra por folio, que es como la gente la nombra", () => {
    expect(filterCardsByName(CARDS, "D904")).toHaveLength(1);
    expect(filterCardsByName(CARDS, "#D199")).toHaveLength(1);
  });

  it("sin búsqueda devuelve TODO, incluidas las sin nombre", () => {
    // Un buscador vacío no filtra: la lista entera es el estado de reposo.
    expect(filterCardsByName(CARDS, "")).toHaveLength(4);
    expect(filterCardsByName(CARDS, "   ")).toHaveLength(4);
  });

  it("una tarjeta sin nombre no revienta la búsqueda", () => {
    expect(filterCardsByName(CARDS, "dave")).toHaveLength(1);
  });
});

describe("las dos listas largas de Mi Día buscan igual", () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, "..", rel), "utf8");
  const screen = read("app/(dashboard)/mi-dia/mi-dia-screen.tsx");
  const unassigned = read("app/(dashboard)/mi-dia/mi-dia-unassigned.tsx");

  it("ambas usan el MISMO filtro", () => {
    // Dos buscadores con reglas distintas en la misma pantalla desconciertan:
    // lo que encuentra uno tiene que encontrarlo el otro.
    expect(screen).toContain("filterCardsByName");
    expect(unassigned).toContain("filterCardsByName");
  });

  it("ambas tienen scroll propio", () => {
    // Con 200 sin asignar la sección medía varias pantallas y enterraba el
    // resto de Mi Día.
    for (const [nombre, src] of [
      ["El resto", screen],
      ["Oportunidades sin asignar", unassigned],
    ] as const) {
      expect(src, `${nombre} necesita scroll propio`).toContain("overflow-y-auto");
    }
  });

  it('"El resto" filtra ANTES de paginar', () => {
    // Buscar sobre las 5 visibles no encontraría nada de las 200 de abajo,
    // que es justo para lo que se busca.
    expect(screen).toContain("filterCardsByName(rest, restQuery)");
    expect(screen).toContain("Math.min(restVisible, restFiltrado.length)");
    expect(screen).toContain("restFiltrado.slice(0, restShown)");
  });
});
