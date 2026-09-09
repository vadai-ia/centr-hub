import type { TagMappingView } from "@/lib/types/admin";

/**
 * Agrupación de tags de Shopify por vendedor (M2v2 #3).
 *
 * PROBLEMA QUE RESUELVE: una misma persona acumula varias tags en Shopify
 * porque el string se escribió distinto a lo largo del tiempo ("GinaJiménez",
 * "Gina", "Gina Jiménez"). Las tres normalizan distinto (la normalización es
 * trim + lowercase, no quita espacios interiores), así que son tres filas de
 * `tag_mappings` — y en la pantalla se leían como si la atribución estuviera
 * partida entre tres personas distintas.
 *
 * NO es una fusión destructiva, y no debe serlo: las tres tags EXISTEN en
 * Shopify y las tres siguen llegando en pedidos nuevos. Borrar dos dejaría
 * sin atribuir cada pedido futuro que traiga esas variantes — una pérdida
 * silenciosa. Lo que se fusiona es la PRESENTACIÓN: un renglón por vendedor,
 * con sus variantes dentro y el total sumado. Cada variante conserva sus
 * acciones propias (cambiar, re-procesar, eliminar si quedó huérfana).
 *
 * Módulo PURO (sin BD ni sesión) para que la lógica de agrupación sea
 * testeable sin levantar la pantalla.
 */

export interface TagVendorGroup {
  /** membership del vendedor; null = tags informativas o sin mapear. */
  membershipId: string | null;
  /** Nombre visible del vendedor, o null si no aplica. */
  vendorName: string | null;
  /** false → vendedor desactivado (mapeo inactivo). null si no aplica. */
  vendorActive: boolean | null;
  /** Variantes de tag que apuntan a este vendedor, de mayor a menor uso. */
  tags: TagMappingView[];
  /** Suma de entidades de todas las variantes. */
  totalCount: number;
}

/**
 * Agrupa por `mapped_membership_id`. Las tags SIN vendedor (informativas o
 * sin mapear) NO se agrupan entre sí — cada una es su propio grupo, porque
 * no comparten sujeto: juntarlas insinuaría una relación que no existe.
 *
 * Orden: grupos por total de entidades descendente (quien más vende arriba);
 * dentro del grupo, las variantes también por uso descendente, de modo que
 * la forma canónica de la tag —la que el equipo usa de verdad— quede primero.
 */
export function groupTagsByVendor(mappings: TagMappingView[]): TagVendorGroup[] {
  const byVendor = new Map<string, TagVendorGroup>();
  const loose: TagVendorGroup[] = [];

  for (const tag of mappings) {
    const key =
      tag.classification === "vendor" && tag.mapped_membership_id
        ? tag.mapped_membership_id
        : null;

    if (key === null) {
      loose.push({
        membershipId: null,
        vendorName: null,
        vendorActive: null,
        tags: [tag],
        totalCount: tag.count,
      });
      continue;
    }

    const existing = byVendor.get(key);
    if (existing) {
      existing.tags.push(tag);
      existing.totalCount += tag.count;
    } else {
      byVendor.set(key, {
        membershipId: key,
        vendorName: tag.mapped_vendor_name,
        vendorActive: tag.mapped_vendor_active,
        tags: [tag],
        totalCount: tag.count,
      });
    }
  }

  const groups: TagVendorGroup[] = Array.from(byVendor.values()).concat(loose);
  for (const g of groups) g.tags.sort((a, b) => b.count - a.count);
  groups.sort((a, b) => b.totalCount - a.totalCount);
  return groups;
}

/** ¿El grupo tiene variantes duplicadas que conviene señalar al admin? */
export function hasDuplicateVariants(group: TagVendorGroup): boolean {
  return group.membershipId !== null && group.tags.length > 1;
}
