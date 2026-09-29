import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Guard estático de "¿a quién le llegó el mensaje?" (sellos 0049 en la UI).
 *
 * Son acoplamientos que ni `tsc` ni la suite mockeada ven caer:
 *
 *  1. **El SELECT del kanban.** El badge de la card lee dos columnas que no
 *     estaban en el select; si alguien las quita "porque no se usan", el
 *     badge desaparece en silencio — la card seguiría compilando, con los
 *     campos en `undefined`.
 *  2. **Lista y conteo con el MISMO predicado.** El badge de cada etapa sale
 *     de `countKanbanOpportunitiesByStage` y las cards de
 *     `listKanbanOpportunities`. Filtrar en una y no en la otra produce un
 *     contador que no corresponde a lo listado — el bug más caro de explicar
 *     porque nadie sabe cuál de los dos números creer.
 *  3. **El gate a Post-venta.** Los sellos solo se pueblan ahí; sin el gate,
 *     encender el filtro en Venta vacía el tablero sin explicación.
 */

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("sellos de mensajería visibles en el pipeline", () => {
  const db = read("lib/db/opportunities.ts");

  it("el kanban SELECCIONA los dos sellos (si no, el badge queda mudo)", () => {
    const select = db.slice(
      db.indexOf("const KANBAN_OPPORTUNITY_SELECT"),
      db.indexOf("contact:contacts!inner"),
    );
    expect(select).toContain("delivery_message_sent_at");
    expect(select).toContain("followup_message_sent_at");
  });

  it("lista y conteo filtran los pendientes con el MISMO predicado", () => {
    const predicado = /\.is\("followup_message_sent_at", null\)/g;
    expect(db.match(predicado)?.length).toBe(2);

    const opcion = /pendingFollowupOnly\?: boolean;/g;
    expect(db.match(opcion)?.length).toBe(2);
  });

  it("el filtro está acotado a Post-venta en la server action", () => {
    const actions = read("lib/actions/pipeline.ts");
    // La carga inicial lo deriva del flag de funnel...
    expect(actions).toMatch(
      /const filterPendingFollowup = isPostventa\s*\n\s*\? opts\.filters\?\.pendingFollowupOnly/,
    );
    // ...y la paginación por scroll repite el gate (si no, la segunda página
    // traería opps que la primera excluyó).
    expect(actions).toMatch(
      /input\.funnel === "post_venta" \? input\.pendingFollowupOnly : undefined/,
    );
  });
});
