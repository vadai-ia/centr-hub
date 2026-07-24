"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { canSeeAllData } from "@/lib/auth/capabilities";
import { withTenantContext } from "@/lib/tenant/context";
import { listActiveRealVendors } from "@/lib/db/users";
import { createLead, LeadValidationError } from "@/lib/services/lead-creation";

/**
 * Server actions de creación manual de leads (0038, Bloque A).
 *
 * Disponible a CUALQUIER usuario autenticado (no solo admin) — la doctrina
 * permite que cualquier vendedor dé de alta un lead. Reusa el camino
 * canónico `createLead` (idéntico al webhook): dedup, guard R12 de opp
 * inicial, atribución, propagación a Whaapy con asesor. NUNCA crea en Shopify.
 */

export interface LeadAdvisorOption {
  id: string;
  name: string;
  color: string | null;
}

export type LeadFormDataResult =
  | { ok: true; advisors: LeadAdvisorOption[]; selfMembershipId: string | null }
  | { ok: false; message: string };

export async function loadLeadFormData(): Promise<LeadFormDataResult> {
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, message: "Sesión expirada. Vuelve a iniciar sesión." };
  }
  const orgId = session.data.activeOrg.id;
  const userId = session.data.userId;
  return withTenantContext(
    orgId,
    async () => {
      const vendors = await listActiveRealVendors(orgId);
      const self = vendors.find((v) => v.user_id === userId)?.id ?? null;
      return {
        ok: true as const,
        advisors: vendors.map((v) => ({
          id: v.id,
          name: v.profile.full_name ?? "Vendedor",
          color: v.profile.color ?? null,
        })),
        selfMembershipId: self,
      };
    },
    { source: "user_session" },
  );
}

const addressSchema = z
  .object({
    address1: z.string().trim().max(200).optional(),
    city: z.string().trim().max(200).optional(),
    province: z.string().trim().max(200).optional(),
    zip: z.string().trim().max(200).optional(),
    country: z.string().trim().max(200).optional(),
  })
  .optional()
  .nullable();

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(1).max(40),
  email: z.string().trim().email().max(200).optional().or(z.literal("")).nullable(),
  advisorId: z.string().uuid().nullable().optional(),
  address: addressSchema,
});

export interface CreateManualLeadResult {
  ok: boolean;
  message: string;
  contactId?: string;
  opportunityId?: string | null;
  contactDeduped?: boolean;
  opportunityCreated?: boolean;
  assignedAdvisorId?: string | null;
}

const VALIDATION_MESSAGES: Record<LeadValidationError["code"], string> = {
  missing_name: "El nombre es obligatorio.",
  missing_phone: "El teléfono es obligatorio.",
  invalid_phone: "El teléfono no es válido. Usa el formato con lada (ej. 55 1234 5678).",
  advisor_not_eligible: "El asesor seleccionado no es válido.",
};

export async function createManualLeadAction(raw: unknown): Promise<CreateManualLeadResult> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: "Revisa los datos: nombre y teléfono son obligatorios." };
  }
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, message: "Sesión expirada. Vuelve a iniciar sesión." };
  }
  const orgId = session.data.activeOrg.id;
  const userId = session.data.userId;

  const email = parsed.data.email && parsed.data.email.trim() ? parsed.data.email.trim() : null;
  const address = parsed.data.address ?? null;

  return withTenantContext(
    orgId,
    async (): Promise<CreateManualLeadResult> => {
      try {
        const result = await createLead({
          fullName: parsed.data.name,
          phone: parsed.data.phone,
          email,
          address,
          assignment: { mode: "explicit", advisorId: parsed.data.advisorId ?? null },
          source: "manual",
          actorUserId: userId,
        });
        revalidatePath("/contactos");
        revalidatePath("/pipeline");

        let message = "Lead creado.";
        if (result.contactCreated === false) {
          message =
            result.opportunityCreated
              ? "El contacto ya existía; se enlazó y se creó una oportunidad “Lead nuevo”."
              : "El contacto ya existía y ya tenía una oportunidad activa; no se creó una nueva.";
        } else if (!result.opportunityCreated) {
          message = "Contacto creado. No se creó oportunidad nueva (ya tenía una activa).";
        }

        return {
          ok: true,
          message,
          contactId: result.contactId,
          opportunityId: result.opportunityId,
          contactDeduped: !result.contactCreated,
          opportunityCreated: result.opportunityCreated,
          assignedAdvisorId: result.assignedAdvisorId,
        };
      } catch (err) {
        if (err instanceof LeadValidationError) {
          return { ok: false, message: VALIDATION_MESSAGES[err.code] };
        }
        throw err;
      }
    },
    { source: "user_session" },
  );
}

// Alta de lead en el funnel Outbound (Fase 2). Sin selección de asesor (el
// SDR no es asignable; el vendedor se elige en el handoff). Marca el contacto
// outbound y propaga la marca. Solo roles con data_scope='all' (admin/SDR) —
// el funnel Outbound es exclusivo de ellos.
const createOutboundSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(1).max(40),
  email: z.string().trim().email().max(200).optional().or(z.literal("")).nullable(),
  address: addressSchema,
});

export async function createOutboundLeadAction(raw: unknown): Promise<CreateManualLeadResult> {
  const parsed = createOutboundSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: "Revisa los datos: nombre y teléfono son obligatorios." };
  }
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, message: "Sesión expirada. Vuelve a iniciar sesión." };
  }
  if (!canSeeAllData(session.data.activeRole)) {
    return { ok: false, message: "No tienes acceso al pipeline Outbound." };
  }
  const orgId = session.data.activeOrg.id;
  const userId = session.data.userId;

  const email = parsed.data.email && parsed.data.email.trim() ? parsed.data.email.trim() : null;
  const address = parsed.data.address ?? null;

  return withTenantContext(
    orgId,
    async (): Promise<CreateManualLeadResult> => {
      try {
        const result = await createLead({
          fullName: parsed.data.name,
          phone: parsed.data.phone,
          email,
          address,
          assignment: { mode: "explicit", advisorId: null },
          source: "manual",
          actorUserId: userId,
          channel: "outbound",
        });
        revalidatePath("/contactos");
        revalidatePath("/pipeline");

        let message = "Lead creado en Outbound.";
        if (result.contactCreated === false) {
          message = result.opportunityCreated
            ? "El contacto ya existía; se marcó como outbound y se creó su oportunidad."
            : "El contacto ya existía y ya tenía una oportunidad Outbound activa; se marcó como outbound.";
        }

        return {
          ok: true,
          message,
          contactId: result.contactId,
          opportunityId: result.opportunityId,
          contactDeduped: !result.contactCreated,
          opportunityCreated: result.opportunityCreated,
          assignedAdvisorId: result.assignedAdvisorId,
        };
      } catch (err) {
        if (err instanceof LeadValidationError) {
          return { ok: false, message: VALIDATION_MESSAGES[err.code] };
        }
        throw err;
      }
    },
    { source: "user_session" },
  );
}
