import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guard estático del arrastre del kanban.
 *
 * El bug que protege no truena nada: al agarrar una tarjeta y moverla un
 * poco, salía disparada varias columnas a la derecha y ya no se dejaba traer
 * de regreso. La causa era que la copia flotante (`DragOverlay`) se
 * registraba con el MISMO id de arrastrable que la tarjeta del tablero, así
 * que dnd-kit medía el nodo equivocado y el desplazamiento se
 * retroalimentaba.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.resolve(ROOT, rel), "utf8");

const card = read("app/(dashboard)/pipeline/kanban-card.tsx");
const board = read("app/(dashboard)/pipeline/pipeline-board.tsx");

describe("la copia flotante no se pisa con la tarjeta del tablero", () => {
  it("el tablero marca la copia del DragOverlay", () => {
    const overlay = board.slice(
      board.indexOf("<DragOverlay"),
      board.indexOf("</DragOverlay>"),
    );
    expect(overlay).toContain("isOverlay");
  });

  it("la copia flotante usa un id de arrastrable DISTINTO", () => {
    // Dos `useDraggable` con el mismo id se pisan el nodo medido.
    expect(card).toContain("__overlay");
    expect(card).toMatch(/id: isOverlay \? `\$\{opp\.id\}__overlay` : opp\.id/);
  });

  it("y no registra ni escucha el arrastre", () => {
    expect(card).toMatch(/disabled: isOverlay \|\|/);
    expect(card).toContain("ref={isOverlay ? undefined : draggable.setNodeRef}");
  });
});

describe("la tarjeta del tablero se queda quieta mientras se arrastra", () => {
  it("no se le aplica el traslado de dnd-kit", () => {
    // Moverla además a ella duplicaba el desplazamiento y, al cambiar su
    // posición, movía la columna que el detector creía tener debajo. De eso
    // se encarga la copia flotante.
    expect(card).not.toContain("CSS.Translate");
    expect(card).not.toContain("@dnd-kit/utilities");
  });
});

describe("el tablero no se va solo al arrastrar", () => {
  it("el desplazamiento automático está APAGADO", () => {
    // Medido en video: con los valores por defecto (franja del 20% del ancho,
    // aceleración 10) el tablero pasaba de la primera columna a la última en
    // ~0,3 s al levantar una tarjeta, y no se dejaba traer de vuelta. En
    // Outbound no pasaba porque sus 3 columnas caben en pantalla: sin scroll
    // horizontal no hay nada que desplazar.
    expect(board).toContain("autoScroll={AUTO_SCROLL}");
    expect(board).toMatch(/const AUTO_SCROLL = false;/);
  });
});

describe("la columna destino la decide el PUNTERO", () => {
  it("pointerWithin manda, con closestCenter de respaldo", () => {
    // El tablero se desplaza en horizontal y las columnas son muy altas: "el
    // centro más cercano" elegía columnas que el cursor ni tocaba.
    expect(board).toContain("pointerWithin");
    expect(board).toContain("collisionDetection={detectarColumnaDestino}");
    const fn = board.slice(
      board.indexOf("function detectarColumnaDestino"),
      board.indexOf("export function PipelineBoard"),
    );
    expect(fn).toContain("pointerWithin(args)");
    // El respaldo no es opcional: sin él, soltar en el hueco entre columnas
    // no haría nada y el movimiento se perdería sin explicación.
    expect(fn).toContain("closestCenter(args)");
  });
});
