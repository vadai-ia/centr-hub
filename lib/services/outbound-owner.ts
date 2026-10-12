import "server-only";
import { getOrganizationById } from "@/lib/db/organizations";
import { getMembership, listActiveRealVendors } from "@/lib/db/users";
import { readOrganizationOutboundOwner } from "@/lib/services/organization-outbound-owner";
import type { UUID } from "@/lib/types/database";

/**
 * A quién nace asignada una oportunidad de **Outbound**.
 *
 * Las dos vías de creación —"Meter a Outbound" desde el contacto y "Crear
 * lead en Outbound" desde el formulario— tenían el asesor cableado a `null`,
 * así que el tablero del SDR amanecía entero en "Sin asignar" (85 de 90 en
 * producción). Vive aquí, en un solo lugar, porque arreglarlo en una sola de
 * las dos habría dejado la mitad de las tarjetas huérfanas igual.
 *
 * Precedencia:
 *   1. El dueño configurado de la organización
 *      (`config.outbound.default_owner_membership_id`) — cambiarlo es un
 *      UPDATE, no un deploy.
 *   2. Quien la está creando, si opera cartera (`is_advisor`). Cubre el caso
 *      normal: el SDR mete el contacto a su propio pipeline.
 *   3. NULL. Sigue siendo un resultado válido —mejor sin dueño que con el
 *      dueño equivocado— pero ya es la excepción, no la regla.
 *
 * **Se valida contra los asesores ACTIVOS en los dos escalones.** Un ancla
 * que apunta a alguien dado de baja no debe tumbar la creación del lead: solo
 * cae al siguiente escalón. `createLead` rechaza un asesor no elegible con
 * `LeadValidationError`, así que sin esta validación un ancla vieja rompería
 * el botón entero en lugar de dejar la tarjeta sin dueño.
 *
 * Nota operativa: para que un SDR pueda ser dueño, su membresía necesita la
 * ranura `is_advisor` encendida (Admin → Usuarios). La ranura es justo el
 * mecanismo para "opera cartera sin ser vendedor de planta" (0050); filtrar
 * por `role` aquí rompería ese invariante.
 */
export async function resolveOutboundOwner(
  organizationId: UUID,
  actorUserId: UUID,
): Promise<UUID | null> {
  const elegibles = await listActiveRealVendors(organizationId);
  const esElegible = (id: string | null | undefined): boolean =>
    !!id && elegibles.some((v) => v.id === id);

  const org = await getOrganizationById(organizationId);
  const configurado = readOrganizationOutboundOwner(org?.config ?? null);
  if (esElegible(configurado)) return configurado;

  const propia = await getMembership(actorUserId, organizationId);
  if (esElegible(propia?.id)) return propia!.id;

  return null;
}
