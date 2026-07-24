"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { canSeeAllData, canAccessAdminPanel } from "@/lib/auth/capabilities";
import { withTenantContext } from "@/lib/tenant/context";
import { getContactById } from "@/lib/db/contacts";
import { getOpportunityById } from "@/lib/db/opportunities";
import { listActiveRealVendors } from "@/lib/db/users";
import { setContactOutbound } from "@/lib/services/outbound-mark";
import { handoffOutboundOpportunity } from "@/lib/services/outbound-handoff";
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

// Entrega (handoff) de una opp de Outbound a un vendedor (Fase 3). Solo desde
// la ÚLTIMA etapa de Outbound ("Cliente calificado" por posición). Gate:
// data_scope='all' (admin/SDR). El vendedor debe ser un asesor real activo.
const handoffSchema = z.object({
  opportunityId: z.string().uuid(),
  advisorMembershipId: z.string().uuid(),
});

const HANDOFF_REASON_MESSAGES: Record<string, string> = {
  not_outbound: "La oportunidad ya no está en Outbound.",
  cancelled: "La oportunidad está cancelada.",
  advisor_not_found: "El asesor seleccionado no existe.",
  advisor_not_eligible: "El asesor seleccionado no es un vendedor activo.",
  target_stage_not_found:
    'No existe la etapa "Contacto calificado" en el Funnel Venta. Revísala en Admin → Etapas.',
  opportunity_not_found: "La oportunidad no existe.",
};

export async function handoffOutboundOpportunityAction(
  raw: unknown,
): Promise<OutboundActionResult> {
  const parsed = handoffSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos inválidos." };
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
      const opp = await getOpportunityById(parsed.data.opportunityId);
      if (!opp) return { ok: false, message: "La oportunidad no existe." };
      if (opp.funnel !== "outbound") {
        return { ok: false, message: "La oportunidad ya no está en Outbound." };
      }

      // El disparador es el gesto de arrastrar la card a "Cliente calificado"
      // (última etapa) en el board — el flip es válido desde cualquier etapa de
      // Outbound, así que aquí basta con validar funnel='outbound' + vendedor.

      // El asesor debe ser un vendedor real activo (misma fuente que el
      // round-robin / selector — el SDR nunca aparece aquí).
      const vendors = await listActiveRealVendors(orgId);
      if (!vendors.some((v) => v.id === parsed.data.advisorMembershipId)) {
        return { ok: false, message: "El asesor seleccionado no es un vendedor activo." };
      }

      const res = await handoffOutboundOpportunity({
        opportunityId: parsed.data.opportunityId,
        advisorMembershipId: parsed.data.advisorMembershipId,
        actorUserId: userId,
      });
      if (!res.ok) {
        return {
          ok: false,
          message:
            (res.reason && HANDOFF_REASON_MESSAGES[res.reason]) ??
            "No se pudo entregar la oportunidad. Intenta de nuevo.",
        };
      }
      revalidatePath("/pipeline");
      return { ok: true, message: "Oportunidad entregada al vendedor (pasó a Venta)." };
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
