/**
 * Búsqueda por nombre dentro de una lista de tarjetas — módulo PURO.
 *
 * Lo usan las dos listas largas de Mi Día ("El resto" y "Oportunidades sin
 * asignar"). Vive aparte porque dos buscadores con reglas distintas en la
 * misma pantalla desconciertan: lo que encuentra uno tiene que encontrarlo
 * el otro.
 */

/** Sin acentos ni mayúsculas: nadie teclea "Rodríguez" con tilde al buscar. */
function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export interface SearchableCard {
  contactName: string | null;
  /** Folio de la cotización (`#D904`), que es como la gente la nombra. */
  displayReference: string | null;
}

/**
 * Filtra por nombre del contacto o por folio. Busca el término EN CUALQUIER
 * PARTE del texto, no solo al inicio: la gente teclea el apellido.
 *
 * Varias palabras = todas tienen que aparecer, en cualquier orden ("centro
 * barranquilla" encuentra "Spininng Center BARRANQUILLA").
 */
export function filterCardsByName<T extends SearchableCard>(
  cards: T[],
  query: string,
): T[] {
  const términos = normalizar(query).split(/\s+/).filter(Boolean);
  if (términos.length === 0) return cards;
  return cards.filter((c) => {
    const heno = normalizar(`${c.contactName ?? ""} ${c.displayReference ?? ""}`);
    return términos.every((t) => heno.includes(t));
  });
}
