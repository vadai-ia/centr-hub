import type { MiDiaBellItem } from "@/lib/services/mi-dia";

/**
 * A dónde lleva un aviso al hacerle clic — módulo PURO.
 *
 * Un aviso que no se puede abrir obliga a buscar a mano lo que anuncia, que
 * es justo el trabajo que venía a ahorrar. Vive aparte porque lo consumen
 * tres sitios —la campanita, los emergentes y el panel de Mi Día— y si cada
 * uno resolviera su destino acabarían llevando a sitios distintos para el
 * mismo aviso.
 *
 * Precedencia: la OPORTUNIDAD manda sobre el contacto. Un aviso de
 * "oportunidad estancada" trae los dos, y lo accionable es la tarjeta: en el
 * contacto habría que volver a buscar de cuál de sus oportunidades habla.
 */

export interface NotificationTarget {
  href: string;
  /** Texto del enlace, para quien lo muestre como acción explícita. */
  label: string;
}

/** Avisos de tarea: el id viaja en `origin_reference`, no en una columna. */
export function taskIdOf(item: Pick<MiDiaBellItem, "originReference">): string | null {
  const ref = item.originReference;
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
  const id = (ref as Record<string, unknown>).task_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function notificationTarget(
  item: Pick<MiDiaBellItem, "opportunityId" | "contactId" | "originReference">,
): NotificationTarget | null {
  if (item.opportunityId) {
    return { href: `/pipeline?opp=${item.opportunityId}`, label: "Ver oportunidad" };
  }
  if (item.contactId) {
    return { href: `/contactos/${item.contactId}`, label: "Ver contacto" };
  }
  // Un recordatorio de tarea no apunta a una tarjeta: su sitio es Mi Día,
  // que es donde se marca. Sin esto el aviso más frecuente del sistema es
  // justo el único que no lleva a ninguna parte.
  if (taskIdOf(item)) {
    return { href: "/mi-dia", label: "Ver tarea" };
  }
  return null;
}
