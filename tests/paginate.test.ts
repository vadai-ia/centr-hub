import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fetchAllPaged, PAGE_SIZE } from "@/lib/db/paginate";

/**
 * Paginado de lecturas masivas (lib/db/paginate.ts).
 *
 * El bug que motivó el módulo: `.limit(50000)` es una petición del CLIENTE,
 * pero PostgREST aplica encima un tope de servidor (1000 por defecto) que
 * gana. La query devolvía una MUESTRA sin error ni aviso — los conteos de
 * atribución sumaban exactamente 1000 cuando el total real era 1297, y los
 * totales por vendedor parecían encoger entre corridas.
 *
 * Estos tests usan un servidor falso que REPLICA ese tope: acepta cualquier
 * rango pero nunca devuelve más de `serverCap` filas. Sin replicarlo, el test
 * pasaría igual con el código roto.
 */

/** Servidor falso con tope duro, como PostgREST. */
function fakeServer(totalRows: number, serverCap = PAGE_SIZE) {
  const rows = Array.from({ length: totalRows }, (_, i) => ({ id: i }));
  const calls: Array<[number, number]> = [];
  const build = () => ({
    range(from: number, to: number) {
      calls.push([from, to]);
      const width = Math.min(to - from + 1, serverCap);
      return Promise.resolve({ data: rows.slice(from, from + width), error: null });
    },
  });
  return { build, calls, rows };
}

describe("fetchAllPaged", () => {
  it("trae TODAS las filas cuando el total supera el tope del servidor", async () => {
    // El caso real: 1297 filas con tope de 1000. Sin paginar se perdían 297.
    const { build } = fakeServer(1297);
    const out = await fetchAllPaged<{ id: number }>(build);
    expect(out).toHaveLength(1297);
    expect(out[0].id).toBe(0);
    expect(out[1296].id).toBe(1296);
  });

  it("no duplica ni saltea filas entre páginas", async () => {
    const { build } = fakeServer(2500);
    const out = await fetchAllPaged<{ id: number }>(build);
    expect(out.map((r) => r.id)).toEqual(Array.from({ length: 2500 }, (_, i) => i));
  });

  it("una sola request cuando todo cabe en la primera página", async () => {
    const { build, calls } = fakeServer(42);
    const out = await fetchAllPaged<{ id: number }>(build);
    expect(out).toHaveLength(42);
    expect(calls).toHaveLength(1);
  });

  it("no hace una request de más cuando el total es múltiplo exacto del tamaño de página", async () => {
    // Página completa = puede haber más; página vacía = fin. Son 2 requests,
    // no 3: la segunda vuelve vacía y corta.
    const { build, calls } = fakeServer(PAGE_SIZE);
    const out = await fetchAllPaged<{ id: number }>(build);
    expect(out).toHaveLength(PAGE_SIZE);
    expect(calls).toHaveLength(2);
  });

  it("tabla vacía → array vacío, una sola request", async () => {
    const { build, calls } = fakeServer(0);
    expect(await fetchAllPaged(build)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("respeta el circuit breaker y NO pide más allá del cap", async () => {
    const { build, calls } = fakeServer(10_000);
    const out = await fetchAllPaged<{ id: number }>(build, 2000);
    expect(out).toHaveLength(2000);
    // Nunca pide un índice más allá del cap.
    expect(Math.max(...calls.map(([, to]) => to))).toBe(1999);
  });

  it("construye una query NUEVA por página (un builder consumido no se re-ejecuta)", async () => {
    const { build } = fakeServer(2500);
    const spy = vi.fn(build);
    await fetchAllPaged<{ id: number }>(spy);
    expect(spy.mock.calls.length).toBeGreaterThan(1);
  });

  it("propaga el error del servidor en vez de devolver datos parciales", async () => {
    const build = () => ({
      range: () =>
        Promise.resolve({ data: null, error: new Error("boom") }),
    });
    await expect(fetchAllPaged(build)).rejects.toThrow("boom");
  });

  it("un error en la SEGUNDA página no se traga como resultado corto", async () => {
    // Sin el throw, esto devolvería 1000 filas y parecería un total válido —
    // exactamente el modo de fallo silencioso que el módulo existe para evitar.
    let call = 0;
    const rows = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: i }));
    const build = () => ({
      range: () => {
        call += 1;
        return Promise.resolve(
          call === 1
            ? { data: rows, error: null }
            : { data: null, error: new Error("timeout") },
        );
      },
    });
    await expect(fetchAllPaged(build)).rejects.toThrow("timeout");
  });
});

describe("guard: ninguna lectura masiva vuelve a confiar en .limit()", () => {
  const ROOT = path.resolve(__dirname, "..");

  // Módulos que barren "todas las filas de la organización". En todos, un
  // `.limit(N)` con N > 1000 es una MUESTRA silenciosa, no un límite.
  const bulkReaders = ["lib/db/dashboard.ts", "lib/db/tag-aggregation.ts"];

  /** Quita comentarios: estos módulos MENCIONAN `.limit(...)` para explicar
   *  por qué no se usa, y esa prosa no debe disparar el guard. */
  function codeOnly(src: string): string {
    return src
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
  }

  for (const rel of bulkReaders) {
    it(`${rel} pagina en vez de limitar`, () => {
      const src = codeOnly(readFileSync(path.resolve(ROOT, rel), "utf8"));
      // Se permite pasar el cap como ARGUMENTO de fetchAllPaged (circuit
      // breaker), pero no encadenado como `.limit(...)` a la query.
      const chained = src.match(/\.limit\([A-Za-z0-9_]+\)/g) ?? [];
      expect(
        chained,
        `${rel} no debe encadenar .limit(<cap>) a una lectura masiva: el ` +
          "servidor corta en 1000 filas y devuelve una muestra sin avisar. " +
          "Usar fetchAllPaged (lib/db/paginate.ts).",
      ).toEqual([]);
      expect(
        src.includes("fetchAllPaged"),
        `${rel} debe leer vía fetchAllPaged`,
      ).toBe(true);
    });
  }
});
