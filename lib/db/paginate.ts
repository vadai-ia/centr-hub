import "server-only";

/**
 * Paginado de lecturas masivas contra PostgREST.
 *
 * POR QUÉ EXISTE: `.limit(50000)` es una petición del CLIENTE. PostgREST
 * aplica ADEMÁS un tope de servidor (`db-max-rows`, 1000 por defecto en
 * Supabase) que GANA sobre el límite pedido. El resultado es una MUESTRA
 * silenciosa: sin error, sin campo de truncamiento, solo un array corto.
 *
 * Es una clase de bug especialmente mala porque el código se lee correcto y
 * los números salen plausibles. Se detectó porque los conteos de un
 * diagnóstico de atribución sumaban EXACTAMENTE 1000 y los totales por
 * vendedor parecían ENCOGER entre corridas: cada fila nueva empujaba a otra
 * fuera de la muestra. El total real era 1297.
 *
 * REGLA: toda lectura que quiera "todas las filas de la organización" debe
 * pasar por aquí. Un `.limit(N)` con N > 1000 NO trae N filas.
 */

/** Tamaño de página. Coincide con el tope por defecto de PostgREST. */
export const PAGE_SIZE = 1000;

/**
 * Query capaz de acotarse por rango. Superficie mínima que necesita
 * `fetchAllPaged`, declarada así para no arrastrar los genéricos de
 * supabase-js hasta cada callsite.
 */
export interface RangeableQuery {
  range(
    from: number,
    to: number,
  ): PromiseLike<{ data: unknown[] | null; error: unknown }>;
}

/**
 * Ejecuta una query paginando hasta agotarla, o hasta `rowCap` filas.
 *
 * `build` DEBE construir una query NUEVA en cada llamada: un builder de
 * supabase-js no se puede re-ejecutar una vez consumido.
 *
 * `rowCap` se conserva como circuit breaker (patrón M5/M6) — corta el
 * paginado, y a diferencia de `.limit()` el servidor no puede
 * reinterpretarlo a la baja.
 */
export async function fetchAllPaged<T>(
  build: () => RangeableQuery,
  rowCap = 50000,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; from < rowCap; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, rowCap) - 1;
    const { data, error } = await build().range(from, to);
    if (error) throw error;
    const page = (data ?? []) as T[];
    all.push(...page);
    // Página incompleta = última página. Evita una request de más.
    if (page.length < to - from + 1) break;
  }
  return all;
}
