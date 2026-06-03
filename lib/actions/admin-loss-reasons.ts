"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenantContext } from "@/lib/tenant/context";
import { resolveAdminContext } from "@/lib/auth/admin-guard";
import {
  countOpportunitiesForLossReason,
  createLossReason,
  deleteLossReason,
  getLossReasonById,
  listLossReasons,
  updateLossReason,
} from "@/lib/db/pipeline";
import type { LossReasonActionResult } from "@/lib/types/admin";

/**
 * Server actions de administración de motivos de pérdida (M7.2,
 * Bloque 4). Solo admin/superadmin. Eliminación bloqueada si el
 * motivo está referenciado por oportunidades; para ocultarlo de
 * futuras pérdidas sin perder el histórico, se desactiva.
 */

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
});

export async function createLossReasonAction(
  raw: unknown,
): Promise<LossReasonActionResult> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos del motivo inválidos." };
  const admin = await resolveAdminContext();
  if (!admin.ok) return admin;

  return withTenantContext(admin.ctx.orgId, async () => {
    await createLossReason({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      is_active: true,
    });
    revalidatePath("/admin/motivos");
    return { ok: true, reasons: await listLossReasons() };
  }, { source: "user_session" });
}

const updateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  is_active: z.boolean(),
});

export async function updateLossReasonAction(
  raw: unknown,
): Promise<LossReasonActionResult> {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Datos del motivo inválidos." };
  const admin = await resolveAdminContext();
  if (!admin.ok) return admin;

  return withTenantContext(admin.ctx.orgId, async () => {
    const existing = await getLossReasonById(parsed.data.id);
    if (!existing) return { ok: false, message: "El motivo no existe." };
    await updateLossReason(parsed.data.id, {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      is_active: parsed.data.is_active,
    });
    revalidatePath("/admin/motivos");
    return { ok: true, reasons: await listLossReasons() };
  }, { source: "user_session" });
}

const deleteSchema = z.object({ id: z.string().uuid() });

export async function deleteLossReasonAction(
  raw: unknown,
): Promise<LossReasonActionResult> {
  const parsed = deleteSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Identificador inválido." };
  const admin = await resolveAdminContext();
  if (!admin.ok) return admin;

  return withTenantContext(admin.ctx.orgId, async () => {
    const existing = await getLossReasonById(parsed.data.id);
    if (!existing) return { ok: false, message: "El motivo no existe." };
    const refCount = await countOpportunitiesForLossReason(parsed.data.id);
    if (refCount > 0) {
      return {
        ok: false,
        message: `No se puede eliminar: ${refCount} oportunidad${refCount === 1 ? "" : "es"} usan este motivo. Desactívalo para ocultarlo de futuras pérdidas conservando el histórico.`,
      };
    }
    await deleteLossReason(parsed.data.id);
    revalidatePath("/admin/motivos");
    return { ok: true, reasons: await listLossReasons() };
  }, { source: "user_session" });
}

export async function loadAdminLossReasons(): Promise<
  | { ok: true; reasons: Awaited<ReturnType<typeof listLossReasons>> }
  | { ok: false; message: string }
> {
  const admin = await resolveAdminContext();
  if (!admin.ok) return admin;
  return withTenantContext(admin.ctx.orgId, async () => {
    return { ok: true, reasons: await listLossReasons() };
  }, { source: "user_session" });
}
