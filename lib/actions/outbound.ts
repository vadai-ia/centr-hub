"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { canSeeAllData, canAccessAdminPanel } from "@/lib/auth/capabilities";
import { withTenantContext } from "@/lib/tenant/context";
import { getContactById } from "@/lib/db/contacts";
import { setContactOutbound } from "@/lib/services/outbound-mark";
import { createLead, LeadValidationError } from "@/lib/services/lead-creation";

/**
 * Acciones de la marca outbound (Fase 2).
 *
 * - `addContactToOutboundAction`: mete un contacto EXISTENTE al pipeline
 *   Outbound (lo trabaja el SDR). Reusa el camino canónico `createLead` con
 *   `channel:"outbound"` → dedup contra sí mismo, marca outbound + propaga a
 *   sus opps no terminales, y crea la opp Outbound (sin asignar). Gate:
 *   data_scope='all' (admin/SDR).
 * - `unsetContactOutboundAction`: corrección ADMIN de un marcado erróneo.
 *   Des-marca el contacto + sus opps no terminales, audit `contact_outbound_unset`.
 *   Gate: acceso a panel de administración (admin/superadmin, NO SDR).
 */

const idSchema = z.object({ contactId: z.string().uuid() });

export interface OutboundActionResult {
  ok: boolean;
  message: string;
}

export async function addContactToOutboundAction(raw: unknown): Promise<OutboundActionResult> {
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Contacto inválido." };
  const session = await getSession();
  if (session.status !== "ok") return { ok: false, message: "Sesión expirada." };
  if (!canSeeAllData(session.data.activeRole)) {
    return { ok: false, message: "No tienes acceso al pipeline Outbound." };
  }
  const orgId = session.data.activeOrg.id;
  const userId = session.data.userId;

  return withTenantContext(
    orgId,
    async (): Promise<OutboundActionResult> => {
      const contact = await getContactById(parsed.data.contactId);
      if (!contact) return { ok: false, message: "El contacto no existe." };
      if (!contact.full_name?.trim()) {
        return { ok: false, message: "El contacto necesita un nombre antes de meterlo a Outbound." };
      }
      if (!contact.phone || contact.missing_phone) {
        return { ok: false, message: "El contacto necesita teléfono antes de meterlo a Outbound." };
      }
      try {
        const result = await createLead({
          fullName: contact.full_name,
          phone: contact.phone,
          email: contact.email,
          assignment: { mode: "explicit", advisorId: null },
          source: "manual",
          actorUserId: userId,
          channel: "outbound",
        });
        revalidatePath("/contactos");
        revalidatePath(`/contactos/${contact.id}`);
        revalidatePath("/pipeline");
        return {
          ok: true,
          message: result.opportunityCreated
            ? "Contacto marcado como outbound y agregado al pipeline Outbound."
            : "Contacto marcado como outbound (ya tenía una oportunidad Outbound activa).",
        };
      } catch (err) {
        if (err instanceof LeadValidationError) {
          return { ok: false, message: "No se pudo procesar el contacto (datos incompletos)." };
        }
        throw err;
      }
    },
    { source: "user_session" },
  );
}

export async function unsetContactOutboundAction(raw: unknown): Promise<OutboundActionResult> {
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Contacto inválido." };
  const session = await getSession();
  if (session.status !== "ok") return { ok: false, message: "Sesión expirada." };
  // Corrección admin: NO el SDR. canAccessAdminPanel distingue admin de SDR.
  if (!canAccessAdminPanel(session.data.activeRole)) {
    return { ok: false, message: "Solo un administrador puede quitar la marca outbound." };
  }
  const orgId = session.data.activeOrg.id;
  const userId = session.data.userId;

  return withTenantContext(
    orgId,
    async (): Promise<OutboundActionResult> => {
      const contact = await getContactById(parsed.data.contactId);
      if (!contact) return { ok: false, message: "El contacto no existe." };
      await setContactOutbound({ contactId: contact.id, value: false, actorUserId: userId });
      revalidatePath("/contactos");
      revalidatePath(`/contactos/${contact.id}`);
      revalidatePath("/pipeline");
      return { ok: true, message: "Marca outbound retirada del contacto y sus oportunidades activas." };
    },
    { source: "user_session" },
  );
}
