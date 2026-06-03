"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/tenant/context";
import {
  countOpportunitiesForStage,
  createStage,
  deleteStage,
  getStageById,
  listPipelineStages,
  reorderStages,
  updateStage,
} from "@/lib/db/pipeline";
import { FUNNELS } from "@/lib/constants";
import type { PipelineStageRow, UUID } from "@/lib/types/database";
import type { StageActionResult } from "@/lib/types/admin";

/**
 * Server actions de administración de etapas del pipeline (M7.2,
 * Bloque 3). Solo admin/superadmin. Cada action resuelve sesión +
 * rol + tenant context y devuelve un resultado uniforme. Las
 * invariantes estructurales (etapa inicial única, terminales
 * obligatorias en Funnel Venta, flags no conflictivos, bloqueo de
 * borrado con oportunidades) se validan en backend además de en UI.
 */

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

interface AdminCtx {
  orgId: UUID;
  userId: UUID;
}

async function resolveAdmin(): Promise<
  { ok: true; ctx: AdminCtx } | { ok: false; message: string }
> {
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, message: "Sesión expirada. Vuelve a iniciar sesión." };
  }
  const role = session.data.activeOrg.role;
  if (role !== "admin" && role !== "superadmin") {
    return { ok: false, message: "No tienes permisos de administrador." };
  }
  return {
    ok: true,
    ctx: { orgId: session.data.activeOrg.id, userId: session.data.userId },
  };
}

function isTerminalCountOk(
  stages: PipelineStageRow[],
  flag: "is_won" | "is_lost",
  excludeId: UUID,
  willHaveFlag: boolean,
): boolean {
  const others = stages.filter((s) => s.id !== excludeId && s[flag]);
  return others.length > 0 || willHaveFlag;
}

const createSchema = z.object({
  funnel: z.enum(FUNNELS),
  name: z.string().trim().min(1).max(80),
  color: z.string().regex(HEX_COLOR, "Color inválido (usa formato #RRGGBB)."),
  default_probability: z.number().min(0).max(100).nullable().optional(),
  is_initial: z.boolean(),
  is_won: z.boolean(),
  is_lost: z.boolean(),
  requires_loss_reason: z.boolean(),
});

export async function createStageAction(raw: unknown): Promise<StageActionResult> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: "Datos de la etapa inválidos." };
  }
  const input = parsed.data;
  if (input.is_won && input.is_lost) {
    return { ok: false, message: "Una etapa no puede ser Ganada y Perdida a la vez." };
  }
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;

  return withTenantContext(admin.ctx.orgId, async () => {
    const stages = await listPipelineStages(input.funnel);
    const maxPosition = stages.reduce((m, s) => Math.max(m, s.position), 0);

    // Si nace como inicial, libera el índice único quitando is_initial
    // de la inicial actual del funnel.
    if (input.is_initial) {
      const currentInitial = stages.find((s) => s.is_initial);
      if (currentInitial) {
        await updateStage(currentInitial.id, { is_initial: false });
      }
    }

    await createStage({
      funnel: input.funnel,
      name: input.name,
      position: maxPosition + 1,
      color: input.color,
      default_probability:
        input.funnel === "venta" && input.default_probability != null
          ? String(input.default_probability)
          : null,
      is_initial: input.is_initial,
      is_won: input.is_won,
      is_lost: input.is_lost,
      requires_loss_reason: input.requires_loss_reason,
      is_active: true,
    });

    revalidatePath("/admin/etapas");
    return { ok: true, stages: await listPipelineStages(input.funnel) };
  }, { source: "user_session" });
}

const updateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  color: z.string().regex(HEX_COLOR, "Color inválido (usa formato #RRGGBB)."),
  default_probability: z.number().min(0).max(100).nullable().optional(),
  is_initial: z.boolean(),
  is_won: z.boolean(),
  is_lost: z.boolean(),
  requires_loss_reason: z.boolean(),
});

export async function updateStageAction(raw: unknown): Promise<StageActionResult> {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: "Datos de la etapa inválidos." };
  }
  const input = parsed.data;
  if (input.is_won && input.is_lost) {
    return { ok: false, message: "Una etapa no puede ser Ganada y Perdida a la vez." };
  }
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;

  return withTenantContext(admin.ctx.orgId, async () => {
    const stage = await getStageById(input.id);
    if (!stage) return { ok: false, message: "La etapa no existe." };
    const stages = await listPipelineStages(stage.funnel);

    // Invariante: el funnel debe conservar UNA etapa inicial.
    if (stage.is_initial && !input.is_initial) {
      return {
        ok: false,
        message:
          "No puedes quitar la marca de etapa inicial sin asignarla a otra. Marca otra etapa como inicial primero.",
      };
    }

    // Invariante Funnel Venta: al menos una Ganada y una Perdida.
    if (stage.funnel === "venta") {
      if (!isTerminalCountOk(stages, "is_won", stage.id, input.is_won)) {
        return { ok: false, message: "El Funnel Venta debe conservar al menos una etapa Ganada." };
      }
      if (!isTerminalCountOk(stages, "is_lost", stage.id, input.is_lost)) {
        return { ok: false, message: "El Funnel Venta debe conservar al menos una etapa Perdida." };
      }
    }

    // Si pasa a inicial y no lo era, transferir la marca.
    if (input.is_initial && !stage.is_initial) {
      const currentInitial = stages.find((s) => s.is_initial && s.id !== stage.id);
      if (currentInitial) {
        await updateStage(currentInitial.id, { is_initial: false });
      }
    }

    await updateStage(stage.id, {
      name: input.name,
      color: input.color,
      default_probability:
        stage.funnel === "venta" && input.default_probability != null
          ? String(input.default_probability)
          : null,
      is_initial: input.is_initial,
      is_won: input.is_won,
      is_lost: input.is_lost,
      requires_loss_reason: input.requires_loss_reason,
    });

    revalidatePath("/admin/etapas");
    return { ok: true, stages: await listPipelineStages(stage.funnel) };
  }, { source: "user_session" });
}

const deleteSchema = z.object({ id: z.string().uuid() });

export async function deleteStageAction(raw: unknown): Promise<StageActionResult> {
  const parsed = deleteSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Identificador inválido." };
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;

  return withTenantContext(admin.ctx.orgId, async () => {
    const stage = await getStageById(parsed.data.id);
    if (!stage) return { ok: false, message: "La etapa no existe." };
    const stages = await listPipelineStages(stage.funnel);

    const oppCount = await countOpportunitiesForStage(stage.id);
    if (oppCount > 0) {
      return {
        ok: false,
        message: `No se puede eliminar: ${oppCount} oportunidad${oppCount === 1 ? "" : "es"} en esta etapa. Muévelas a otra etapa primero.`,
      };
    }
    if (stage.is_initial) {
      return {
        ok: false,
        message: "No puedes eliminar la etapa inicial. Marca otra como inicial primero.",
      };
    }
    if (stage.funnel === "venta") {
      if (stage.is_won && !isTerminalCountOk(stages, "is_won", stage.id, false)) {
        return { ok: false, message: "El Funnel Venta debe conservar al menos una etapa Ganada." };
      }
      if (stage.is_lost && !isTerminalCountOk(stages, "is_lost", stage.id, false)) {
        return { ok: false, message: "El Funnel Venta debe conservar al menos una etapa Perdida." };
      }
    }

    await deleteStage(stage.id);
    revalidatePath("/admin/etapas");
    return { ok: true, stages: await listPipelineStages(stage.funnel) };
  }, { source: "user_session" });
}

const reorderSchema = z.object({
  funnel: z.enum(FUNNELS),
  orderedIds: z.array(z.string().uuid()).min(1),
});

export async function reorderStagesAction(raw: unknown): Promise<StageActionResult> {
  const parsed = reorderSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Orden inválido." };
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;

  return withTenantContext(admin.ctx.orgId, async () => {
    await reorderStages(parsed.data.funnel, parsed.data.orderedIds);
    revalidatePath("/admin/etapas");
    return { ok: true, stages: await listPipelineStages(parsed.data.funnel) };
  }, { source: "user_session" });
}

/**
 * Carga inicial para la pantalla admin de etapas: ambas variantes de
 * funnel. Usada por el Server Component de la página.
 */
export async function loadAdminStages(): Promise<
  | { ok: true; venta: PipelineStageRow[]; postVenta: PipelineStageRow[] }
  | { ok: false; message: string }
> {
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;
  return withTenantContext(admin.ctx.orgId, async () => {
    const [venta, postVenta] = await Promise.all([
      listPipelineStages("venta"),
      listPipelineStages("post_venta"),
    ]);
    return { ok: true, venta, postVenta };
  }, { source: "user_session" });
}
