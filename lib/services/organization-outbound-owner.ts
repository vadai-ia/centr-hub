import type { Json, UUID } from "@/lib/types/database";

/**
 * Dueño por defecto del pipeline **Outbound** —
 * `organizations.config.outbound.default_owner_membership_id`.
 *
 * Por qué existe: las oportunidades de Outbound nacían con el asesor cableado
 * a `null`, así que el tablero del SDR amanecía entero en "Sin asignar" (85
 * de 90 en producción). Una tarjeta sin dueño no la trabaja nadie y no se
 * puede medir contra nadie.
 *
 * Se ancla por `membership_id` estable, mismo patrón que el Customer Success
 * de Post-venta (0047) y el resolver de casos: editar nombre o correo de la
 * persona NO cambia el ancla, y cambiar de persona es un UPDATE, no un
 * deploy.
 *
 * Módulo PURO. Devolver `null` es un resultado válido —una organización que
 * no usa Outbound no tiene por qué configurar dueño— y el caller decide el
 * respaldo.
 */
export function readOrganizationOutboundOwner(
  config: Json | null | undefined,
): UUID | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const outbound = (config as Record<string, unknown>).outbound;
  if (!outbound || typeof outbound !== "object" || Array.isArray(outbound)) {
    return null;
  }
  const raw = (outbound as Record<string, unknown>).default_owner_membership_id;
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length > 0 ? (value as UUID) : null;
}
