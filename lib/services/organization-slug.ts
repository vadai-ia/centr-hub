/**
 * Derivación y validación del `slug` de una organización (0048).
 *
 * Módulo PURO (sin BD, sin sesión): lo comparten el modal de creación —que
 * muestra el slug en vivo mientras el admin escribe el nombre— y la server
 * action que lo valida antes de crear. Si viviera solo en el servidor, la
 * UI mostraría una cosa y el backend guardaría otra.
 *
 * El slug es INMUTABLE una vez creada la organización: es el discriminador
 * que la automation de Whaapy Post-venta manda en el body del webhook
 * (`{"org": "<slug>"}`), el que consumen todos los scripts operativos
 * (`--org-slug`) y el que congela el email del usuario sistema "Histórico"
 * (`historico@<slug>.centrhub.local`). Por eso solo se elige al crear.
 */

/** Longitud máxima — holgada, pero evita slugs absurdos en los comandos. */
export const ORG_SLUG_MAX_LENGTH = 40;

/** ASCII en minúsculas, guiones entre palabras, sin guiones en los extremos. */
export const ORG_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Marcas diacríticas combinantes que deja `normalize("NFD")` al separar. */
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

/**
 * Slug ASCII estable a partir del nombre visible. Los acentos se PLIEGAN a
 * su letra base ("Centr Colombia Diseño" -> "centr-colombia-diseno") en vez
 * de convertirse en guiones — un slug con guiones sueltos se ve accidental
 * y este valor va a quedar congelado para siempre.
 */
export function deriveOrgSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ORG_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
}

/** Mensaje de error del slug, o null si es válido. */
export function validateOrgSlug(slug: string): string | null {
  if (slug.length === 0) {
    return "El identificador no puede quedar vacío. Usa letras o números en el nombre.";
  }
  if (slug.length > ORG_SLUG_MAX_LENGTH) {
    return `El identificador no puede pasar de ${ORG_SLUG_MAX_LENGTH} caracteres.`;
  }
  if (!ORG_SLUG_PATTERN.test(slug)) {
    return "El identificador solo admite minúsculas, números y guiones (sin guiones al inicio ni al final).";
  }
  return null;
}
