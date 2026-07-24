"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { hasTab } from "@/lib/auth/capabilities";
import { withTenantContext } from "@/lib/tenant/context";
import {
  countOpportunitiesForStage,
  countStageHistoryReferences,
  createStage,
  deleteStage,
  getStageById,
  listPipelineStages,
  reorderStages,
  updateStage,
} from "@/lib/db/pipeline";
import { listActiveRuleStageNames } from "@/lib/db/automation";
import { computeStageAutomation } from "@/lib/services/stage-automation";
import { recordAuditEvent } from "@/lib/db/operational";
import { FUNNELS } from "@/lib/constants";
import type { Funnel, PipelineStageRow, UUID } from "@/lib/types/database";
import type {
  StageActionResult,
  StageAdminView,
  StageDeletionPlanResult,
} from "@/lib/types/admin";

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
  if (!hasTab(session.data.activeRole, "admin-etapas")) {
    return { ok: false, message: "No tienes permisos para esta sección." };
  }
  return {
    ok: true,
    ctx: { orgId: session.data.activeOrg.id, userId: session.data.userId },
  };
}

/**
 * Enriquece las etapas de un funnel con su dependencia de
 * automatizaciones (para badges + advertencias en la UI). Debe correr
 * dentro de `withTenantContext`. Una sola query de reglas activas se
 * comparte para todas las etapas.
 */
async function enrichStages(funnel: Funnel): Promise<StageAdminView[]> {
  const [stages, ruleRefs] = await Promise.all([
    listPipelineStages(funnel),
    listActiveRuleStageNames(),
  ]);
  return stages.map((s) => ({
    ...s,
    automation: computeStageAutomation(s, stages, ruleRefs),
  }));
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
    return { ok: true, stages: await enrichStages(input.funnel) };
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
    return { ok: true, stages: await enrichStages(stage.funnel) };
  }, { source: "user_session" });
}

const deleteSchema = z.object({
  id: z.string().uuid(),
  /** Palabra "eliminar" tecleada por el admin — obligatoria solo para el
   *  borrado en DURO de una etapa ligada a automatizaciones. */
  confirm: z.string().optional(),
});

/**
 * Resuelve QUÉ se puede hacer con una etapa al pedir su borrado, sin
 * mutar nada (Bloque A). El cliente lo llama al abrir el diálogo para
 * pintar el flujo correcto (borrar / desactivar / bloqueado) y las
 * advertencias de automatización.
 */
export async function prepareStageDeletionAction(
  raw: unknown,
): Promise<StageDeletionPlanResult> {
  const parsed = deleteSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Identificador inválido." };
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;

  return withTenantContext(admin.ctx.orgId, async () => {
    const stage = await getStageById(parsed.data.id);
    if (!stage) return { ok: false, message: "La etapa no existe." };
    const [stages, ruleRefs, oppCount, historyCount] = await Promise.all([
      listPipelineStages(stage.funnel),
      listActiveRuleStageNames(),
      countOpportunitiesForStage(stage.id),
      countStageHistoryReferences(stage.id),
    ]);
    const automation = computeStageAutomation(stage, stages, ruleRefs);
    const hasHistory = historyCount > 0;
    const action: "delete" | "deactivate" | "blocked" =
      oppCount > 0 ? "blocked" : hasHistory ? "deactivate" : "delete";
    return {
      ok: true,
      plan: { action, opportunityCount: oppCount, hasHistory, automation },
    };
  }, { source: "user_session" });
}

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

    // ¿La etapa tiene historial inmutable? El FK
    // `opportunity_stage_history.to_stage_id ... on delete restrict`
    // impide el borrado en duro; en ese caso se DESACTIVA (archiva)
    // preservando la trazabilidad, en lugar de fallar en silencio.
    const historyCount = await countStageHistoryReferences(stage.id);
    const ruleRefs = await listActiveRuleStageNames();
    const automation = computeStageAutomation(stage, stages, ruleRefs);

    if (historyCount > 0) {
      // Desactivar. No pedimos la palabra "eliminar" (no es un borrado);
      // la advertencia de automatización se muestra en la UI.
      if (!stage.is_active) {
        // Ya estaba desactivada — idempotente.
        return { ok: true, stages: await enrichStages(stage.funnel), outcome: "deactivated" };
      }
      await updateStage(stage.id, { is_active: false });
      await recordAuditEvent({
        actorUserId: admin.ctx.userId,
        eventType: "pipeline_stage_deactivated",
        entityType: "pipeline_stage",
        entityId: stage.id,
        payload: {
          funnel: stage.funnel,
          name: stage.name,
          reason: "has_immutable_history",
          history_references: historyCount,
          automation_linked: automation.linked,
        },
      });
      revalidatePath("/admin/etapas");
      return { ok: true, stages: await enrichStages(stage.funnel), outcome: "deactivated" };
    }

    // Borrado en DURO (sin oportunidades ni historial). Si la etapa está
    // ligada a automatizaciones, exigimos la palabra "eliminar" (el
    // backend revalida; la UI la pide).
    if (automation.linked && parsed.data.confirm?.trim().toLowerCase() !== "eliminar") {
      return {
        ok: false,
        message:
          'Esta etapa está ligada a automatizaciones. Escribe la palabra "eliminar" para confirmar.',
      };
    }

    try {
      await deleteStage(stage.id);
    } catch {
      // Defensa de fondo: cualquier FK inesperado (p. ej. una referencia
      // nueva) se traduce en mensaje accionable en vez de colgar la UI.
      return {
        ok: false,
        message:
          "No se pudo eliminar la etapa: tiene referencias en el sistema. Se puede desactivar en su lugar.",
      };
    }
    await recordAuditEvent({
      actorUserId: admin.ctx.userId,
      eventType: "pipeline_stage_deleted",
      entityType: "pipeline_stage",
      entityId: stage.id,
      payload: { funnel: stage.funnel, name: stage.name, automation_linked: automation.linked },
    });
    revalidatePath("/admin/etapas");
    return { ok: true, stages: await enrichStages(stage.funnel), outcome: "deleted" };
  }, { source: "user_session" });
}

const reactivateSchema = z.object({ id: z.string().uuid() });

/**
 * Reactiva una etapa desactivada (deshace la desactivación por
 * historial, Bloque A). Reponer el `is_initial`/terminales no aplica —
 * solo levanta el flag `is_active`. La etapa vuelve a aparecer como
 * columna del kanban y como destino válido de movimientos.
 */
export async function reactivateStageAction(raw: unknown): Promise<StageActionResult> {
  const parsed = reactivateSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Identificador inválido." };
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;

  return withTenantContext(admin.ctx.orgId, async () => {
    const stage = await getStageById(parsed.data.id);
    if (!stage) return { ok: false, message: "La etapa no existe." };
    if (stage.is_active) {
      return { ok: true, stages: await enrichStages(stage.funnel), outcome: "reactivated" };
    }
    await updateStage(stage.id, { is_active: true });
    await recordAuditEvent({
      actorUserId: admin.ctx.userId,
      eventType: "pipeline_stage_reactivated",
      entityType: "pipeline_stage",
      entityId: stage.id,
      payload: { funnel: stage.funnel, name: stage.name },
    });
    revalidatePath("/admin/etapas");
    return { ok: true, stages: await enrichStages(stage.funnel), outcome: "reactivated" };
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
    return { ok: true, stages: await enrichStages(parsed.data.funnel) };
  }, { source: "user_session" });
}

/**
 * Carga inicial para la pantalla admin de etapas: ambas variantes de
 * funnel. Usada por el Server Component de la página.
 */
export async function loadAdminStages(): Promise<
  | { ok: true; outbound: StageAdminView[]; venta: StageAdminView[]; postVenta: StageAdminView[] }
  | { ok: false; message: string }
> {
  const admin = await resolveAdmin();
  if (!admin.ok) return admin;
  return withTenantContext(admin.ctx.orgId, async () => {
    const [outbound, venta, postVenta] = await Promise.all([
      enrichStages("outbound"),
      enrichStages("venta"),
      enrichStages("post_venta"),
    ]);
    return { ok: true, outbound, venta, postVenta };
  }, { source: "user_session" });
}
