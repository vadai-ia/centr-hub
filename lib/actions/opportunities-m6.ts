"use server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/tenant/context";
import {
  getOpportunityDetail,
  type OpportunityDetail,
} from "@/lib/db/opportunities-detail";
import {
  getOpportunityTimeline,
  type TimelineEvent,
} from "@/lib/services/timeline";
import { getOpportunityById } from "@/lib/db/opportunities";
import { getMembership, listActiveRealVendors } from "@/lib/db/users";
import {
  createTask,
  deleteTask,
  getTaskById,
  listTasksForOpportunity,
  recordActivity,
  recordAuditEvent,
  updateTask,
} from "@/lib/db/operational";
import { getOrganizationById } from "@/lib/db/organizations";
import type { Role, TaskRow, UUID } from "@/lib/types/database";
import type { AdvisorOption } from "@/lib/actions/contacts";

/**
 * Server actions del detalle de oportunidad (M6 — B4).
 *
 * Acceso: admin/superadmin siempre; vendedor solo si `assigned_advisor_id`
 * de la opp matchea su membership. Sin membership o sin acceso → `forbidden`.
 * El popup B4 consume `loadOpportunityDetailForDialog(opportunityId)` cada
 * vez que el URL ?opp=<id> cambia.
 */

export interface OpportunityTaskItem {
  id: UUID;
  title: string;
  description: string | null;
  task_type: string;
  status: string;
  due_at: string | null;
  completed_at: string | null;
  created_at: string;
  assigned_user_id: UUID;
  assignedUserName: string | null;
}

export interface OpportunityDialogBundle {
  detail: OpportunityDetail;
  timeline: TimelineEvent[];
  tasks: OpportunityTaskItem[];
  advisors: AdvisorOption[];
  role: Role;
  selfMembershipId: UUID | null;
  /** URL absoluta al customer en Shopify Admin, si el contacto tiene
   *  identidad enlazada y la org tiene shopify_store_domain configurado.
   *  Reemplaza al "Ver link de cobro" pedido en el lote polish M6. */
  shopifyCustomerUrl: string | null;
  /** Subtotal de productos = sum(final_price * quantity). Para
   *  desambiguar contra el total del header (incluye envío + impuestos). */
  lineItemsSubtotal: number;
  /** Vendedor asignado o admin pueden añadir nota / crear tarea. */
  canAddNote: boolean;
  canCreateTask: boolean;
  /** Permite cualquier acción sobre las tasks de esta opp (completar, editar, borrar). */
  canManageTasks: boolean;
  /** Solo admin reasigna. */
  canReassign: boolean;
  /** Lead + (vendedor asignado o admin) habilita "Crear en Shopify". */
  canCreateInShopify: boolean;
}

export type LoadOpportunityDialogResult =
  | { ok: true; bundle: OpportunityDialogBundle }
  | {
      ok: false;
      reason: "not_found" | "forbidden" | "no_session" | "no_membership";
      message: string;
    };

const loadSchema = z.object({
  opportunityId: z.string().uuid(),
});

export async function loadOpportunityDetailForDialog(
  raw: unknown,
): Promise<LoadOpportunityDialogResult> {
  const parsed = loadSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "not_found",
      message: "Parámetros inválidos.",
    };
  }
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, reason: "no_session", message: "Sesión expirada." };
  }
  const orgId = session.data.activeOrg.id;
  const role = session.data.activeOrg.role;
  const userId = session.data.userId;
  const isAdmin = role === "admin" || role === "superadmin";

  return withTenantContext(orgId, async () => {
    const membership = await getMembership(userId, orgId);
    if (!isAdmin && !membership) {
      return {
        ok: false,
        reason: "no_membership",
        message: "No tienes acceso a esta organización.",
      } as const;
    }

    const detail = await getOpportunityDetail(parsed.data.opportunityId);
    if (!detail) {
      return {
        ok: false,
        reason: "not_found",
        message: "Esta oportunidad no existe o no tienes acceso.",
      } as const;
    }

    if (!isAdmin) {
      const assignedToSelf =
        detail.opportunity.assigned_advisor_id === membership?.id;
      if (!assignedToSelf) {
        // Audit del intento — útil para detectar uso indebido o
        // links compartidos accidentalmente.
        try {
          await import("@/lib/db/operational").then(({ recordAuditEvent }) =>
            recordAuditEvent({
              actorUserId: userId,
              eventType: "opportunity_access_forbidden",
              entityType: "opportunity",
              entityId: parsed.data.opportunityId,
              payload: { reason: "not_assigned" },
            }),
          );
        } catch {
          // ignore
        }
        // Devolvemos `not_found` para no distinguir "no existe" vs
        // "sin acceso" — evita filtración de IDs válidos a vendedores
        // que no deberían saber que existen.
        return {
          ok: false,
          reason: "not_found",
          message: "Esta oportunidad no existe o ya no está disponible.",
        } as const;
      }
    }

    const [timeline, vendors, tasks, org] = await Promise.all([
      getOpportunityTimeline(parsed.data.opportunityId),
      listActiveRealVendors(orgId),
      listTasksForOpportunity(parsed.data.opportunityId),
      getOrganizationById(orgId),
    ]);

    const canAct = isAdmin || detail.opportunity.assigned_advisor_id === membership?.id;

    // Subtotal de productos para etiqueta de monto del popup. Se calcula
    // server-side para que el header pueda mostrar la diferencia entre
    // "total de la orden Shopify" (incluye envío + impuestos) y "subtotal
    // de productos" sin que la UI tenga que sumar.
    const lineItemsSubtotal = detail.lineItems.reduce(
      (acc, it) => acc + Number(it.final_price) * it.quantity,
      0,
    );

    // URL del customer en Shopify Admin. Reemplaza al botón "link de
    // cobro" pedido en el lote polish — el vendedor quiere ir al cliente
    // en Shopify, no al cobro.
    let shopifyCustomerUrl: string | null = null;
    if (org?.shopify_store_domain && detail.contact.shopify_customer_id) {
      shopifyCustomerUrl = `https://${org.shopify_store_domain}/admin/customers/${detail.contact.shopify_customer_id}`;
    }

    // Enriquecer tasks con nombre del usuario asignado en una sola
    // pasada (anti N+1). Usa el set de vendors ya cargado.
    const vendorById = new Map(vendors.map((v) => [v.user_id, v.profile.full_name] as const));
    const taskItems: OpportunityTaskItem[] = tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      task_type: t.task_type,
      status: t.status,
      due_at: t.due_at,
      completed_at: t.completed_at,
      created_at: t.created_at,
      assigned_user_id: t.assigned_user_id,
      assignedUserName: vendorById.get(t.assigned_user_id) ?? null,
    }));

    return {
      ok: true,
      bundle: {
        detail,
        timeline,
        tasks: taskItems,
        role,
        selfMembershipId: membership?.id ?? null,
        shopifyCustomerUrl,
        lineItemsSubtotal,
        canAddNote: canAct,
        canCreateTask: canAct,
        canManageTasks: canAct,
        canReassign: isAdmin,
        canCreateInShopify:
          canAct &&
          detail.contact.shopify_customer_id === null &&
          !!detail.contact.phone,
        advisors: vendors.map((v) => ({
          membershipId: v.id,
          userId: v.user_id,
          fullName: v.profile.full_name,
          color: v.profile.color,
        })),
      },
    } as const;
  }, { source: "user_session" });
}

// ============================================================
// Notas manuales (M6 — B9)
// ============================================================

const addNoteSchema = z.object({
  opportunityId: z.string().uuid(),
  note: z.string().trim().min(1).max(5000),
});

export type AddNoteResult =
  | { ok: true; activityId: UUID }
  | {
      ok: false;
      reason: "no_session" | "forbidden" | "invalid_input" | "not_found" | "internal_error";
      message: string;
    };

/**
 * Agrega una nota manual sobre una oportunidad (M6 — B9).
 *
 * Persistencia: tabla `activities` con `activity_type = 'manual_note'`.
 * Esto la hace aparecer automáticamente en el timeline unificado del
 * contacto y de la oportunidad (ver `lib/services/timeline.ts`).
 *
 * Atomicidad: el orden es `activity` → `audit_log`. Si el audit falla
 * (raro), la nota queda persistida — es el dato operativo. El audit
 * es traza informativa; aceptamos el trade-off porque ambas tablas
 * son inmutables y no soportan rollback.
 */
export async function addNoteToOpportunityAction(
  raw: unknown,
): Promise<AddNoteResult> {
  const parsed = addNoteSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_input",
      message: "Escribe una nota entre 1 y 5000 caracteres.",
    };
  }
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, reason: "no_session", message: "Sesión expirada." };
  }
  const orgId = session.data.activeOrg.id;
  const role = session.data.activeOrg.role;
  const userId = session.data.userId;
  const isAdmin = role === "admin" || role === "superadmin";

  return withTenantContext(orgId, async () => {
    const membership = await getMembership(userId, orgId);
    const opp = await getOpportunityById(parsed.data.opportunityId);
    if (!opp) {
      return {
        ok: false,
        reason: "not_found",
        message: "La oportunidad ya no existe.",
      };
    }
    if (!isAdmin && opp.assigned_advisor_id !== membership?.id) {
      return {
        ok: false,
        reason: "forbidden",
        message: "No tienes acceso a esta oportunidad.",
      };
    }
    try {
      const activity = await recordActivity({
        contactId: opp.contact_id,
        opportunityId: opp.id,
        activityType: "manual_note",
        description: parsed.data.note,
        triggeredByUserId: userId,
      });
      try {
        await recordAuditEvent({
          actorUserId: userId,
          eventType: "opportunity_note_added",
          entityType: "opportunity",
          entityId: opp.id,
          payload: { activity_id: activity.id, length: parsed.data.note.length },
        });
      } catch {
        // ignore — la nota ya quedó persistida en activities
      }
      return { ok: true, activityId: activity.id };
    } catch (e) {
      return {
        ok: false,
        reason: "internal_error",
        message: e instanceof Error ? e.message : "No se pudo guardar la nota.",
      };
    }
  }, { source: "user_session" });
}

// ============================================================
// Tareas manuales (M6 — B9)
// ============================================================

const TASK_TYPES = [
  "call",
  "message",
  "quote",
  "follow_up",
  "meeting",
  "other",
] as const;

const createTaskSchema = z.object({
  opportunityId: z.string().uuid(),
  taskType: z.enum(TASK_TYPES),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  dueAt: z.string().datetime().optional().or(z.literal("")),
});

export type CreateTaskResult =
  | { ok: true; taskId: UUID }
  | {
      ok: false;
      reason: "no_session" | "forbidden" | "invalid_input" | "not_found" | "internal_error";
      message: string;
    };

/**
 * Crea una tarea manual asociada a una oportunidad (M6 — B9).
 *
 * Asignación: por simplicidad MVP, la tarea se asigna al `user_id`
 * del que la crea (`assigned_user_id`). M9 (Mi Día) lista las tareas
 * del usuario actual. Si Centr necesita reasignar a otro vendedor,
 * lo cubre F7/V2.
 *
 * El `task_type` está restringido a un set conocido (call, message,
 * quote, follow_up, meeting, other). La BD no impone check constraint
 * (text libre); este enum es solo de UI y deja la puerta abierta a
 * que reglas (M8) generen otros tipos sin tocar este schema.
 */
export async function createTaskForOpportunityAction(
  raw: unknown,
): Promise<CreateTaskResult> {
  const parsed = createTaskSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_input",
      message: "Datos inválidos. Revisa título, tipo y fecha.",
    };
  }
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, reason: "no_session", message: "Sesión expirada." };
  }
  const orgId = session.data.activeOrg.id;
  const role = session.data.activeOrg.role;
  const userId = session.data.userId;
  const isAdmin = role === "admin" || role === "superadmin";

  return withTenantContext(orgId, async () => {
    const membership = await getMembership(userId, orgId);
    const opp = await getOpportunityById(parsed.data.opportunityId);
    if (!opp) {
      return {
        ok: false,
        reason: "not_found",
        message: "La oportunidad ya no existe.",
      };
    }
    if (!isAdmin && opp.assigned_advisor_id !== membership?.id) {
      return {
        ok: false,
        reason: "forbidden",
        message: "No tienes acceso a esta oportunidad.",
      };
    }
    const dueAt = parsed.data.dueAt && parsed.data.dueAt.length > 0
      ? parsed.data.dueAt
      : null;
    const description = parsed.data.description && parsed.data.description.length > 0
      ? parsed.data.description
      : null;

    try {
      const task = await createTask({
        contact_id: opp.contact_id,
        opportunity_id: opp.id,
        assigned_user_id: userId,
        task_type: parsed.data.taskType,
        title: parsed.data.title,
        description,
        due_at: dueAt,
        status: "pending",
        snoozed_until: null,
        completed_at: null,
      });
      try {
        await recordAuditEvent({
          actorUserId: userId,
          eventType: "opportunity_task_created",
          entityType: "opportunity",
          entityId: opp.id,
          payload: {
            task_id: task.id,
            task_type: parsed.data.taskType,
            assigned_user_id: userId,
            due_at: dueAt,
          },
        });
      } catch {
        // ignore — la task ya existe
      }
      return { ok: true, taskId: task.id };
    } catch (e) {
      return {
        ok: false,
        reason: "internal_error",
        message: e instanceof Error ? e.message : "No se pudo crear la tarea.",
      };
    }
  }, { source: "user_session" });
}


// ============================================================
// Acciones sobre tareas existentes (lote polish M6)
// ============================================================

const taskIdSchema = z.object({
  taskId: z.string().uuid(),
});

const editTaskSchema = z.object({
  taskId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  dueAt: z.string().datetime().optional().or(z.literal("")).nullable(),
  taskType: z.enum(TASK_TYPES).optional(),
});

export type TaskActionResult =
  | { ok: true; taskId: UUID }
  | {
      ok: false;
      reason:
        | "no_session"
        | "forbidden"
        | "invalid_input"
        | "not_found"
        | "internal_error";
      message: string;
    };

async function loadTaskWithAccess(
  taskId: UUID,
): Promise<
  | { ok: true; task: TaskRow; orgId: UUID; userId: UUID; isAdmin: boolean; membershipId: UUID | null }
  | { ok: false; result: TaskActionResult }
> {
  const session = await getSession();
  if (session.status !== "ok") {
    return {
      ok: false,
      result: { ok: false, reason: "no_session", message: "Sesión expirada." },
    };
  }
  const orgId = session.data.activeOrg.id;
  const role = session.data.activeOrg.role;
  const userId = session.data.userId;
  const isAdmin = role === "admin" || role === "superadmin";

  const inner = await withTenantContext(orgId, async () => {
    const membership = await getMembership(userId, orgId);
    const task = await getTaskById(taskId);
    if (!task) {
      return {
        kind: "not_found" as const,
      };
    }
    // Acceso: admin, o usuario asignado a la tarea, o asesor asignado
    // a la oportunidad de la tarea.
    if (!isAdmin) {
      const isAssignedToTask = task.assigned_user_id === userId;
      let isAssignedToOpp = false;
      if (!isAssignedToTask && task.opportunity_id) {
        const opp = await getOpportunityById(task.opportunity_id);
        isAssignedToOpp =
          !!opp && !!membership && opp.assigned_advisor_id === membership.id;
      }
      if (!isAssignedToTask && !isAssignedToOpp) {
        return { kind: "forbidden" as const };
      }
    }
    return {
      kind: "ok" as const,
      task,
      orgId,
      userId,
      isAdmin,
      membershipId: membership?.id ?? null,
    };
  }, { source: "user_session" });

  if (inner.kind === "not_found") {
    return {
      ok: false,
      result: { ok: false, reason: "not_found", message: "La tarea ya no existe." },
    };
  }
  if (inner.kind === "forbidden") {
    return {
      ok: false,
      result: { ok: false, reason: "forbidden", message: "No tienes acceso a esta tarea." },
    };
  }
  return {
    ok: true,
    task: inner.task,
    orgId: inner.orgId,
    userId: inner.userId,
    isAdmin: inner.isAdmin,
    membershipId: inner.membershipId,
  };
}

/** Marca una tarea como completada (o la reabre si ya estaba). */
export async function toggleTaskCompletedAction(
  raw: unknown,
): Promise<TaskActionResult> {
  const parsed = taskIdSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_input", message: "Parámetros inválidos." };
  }
  const access = await loadTaskWithAccess(parsed.data.taskId);
  if (!access.ok) return access.result;

  return withTenantContext(access.orgId, async () => {
    const target = access.task;
    const isCompleting = target.status !== "completed";
    try {
      await updateTask(target.id, {
        status: isCompleting ? "completed" : "pending",
        completed_at: isCompleting ? new Date().toISOString() : null,
      });
      try {
        await recordAuditEvent({
          actorUserId: access.userId,
          eventType: isCompleting ? "opportunity_task_completed" : "opportunity_task_reopened",
          entityType: "opportunity",
          entityId: target.opportunity_id ?? target.id,
          payload: { task_id: target.id },
        });
      } catch {
        // best-effort
      }
      return { ok: true, taskId: target.id };
    } catch (e) {
      return {
        ok: false,
        reason: "internal_error",
        message: e instanceof Error ? e.message : "No se pudo actualizar la tarea.",
      };
    }
  }, { source: "user_session" });
}

/** Edita campos de una tarea existente. */
export async function editTaskAction(raw: unknown): Promise<TaskActionResult> {
  const parsed = editTaskSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_input",
      message: "Datos inválidos. Revisa título y fecha.",
    };
  }
  const access = await loadTaskWithAccess(parsed.data.taskId);
  if (!access.ok) return access.result;

  return withTenantContext(access.orgId, async () => {
    const dueAt = parsed.data.dueAt && parsed.data.dueAt.length > 0
      ? parsed.data.dueAt
      : null;
    const description = parsed.data.description && parsed.data.description.length > 0
      ? parsed.data.description
      : null;
    try {
      await updateTask(parsed.data.taskId, {
        title: parsed.data.title.trim(),
        description,
        due_at: dueAt,
        task_type: parsed.data.taskType ?? access.task.task_type,
      });
      try {
        await recordAuditEvent({
          actorUserId: access.userId,
          eventType: "opportunity_task_edited",
          entityType: "opportunity",
          entityId: access.task.opportunity_id ?? access.task.id,
          payload: { task_id: parsed.data.taskId },
        });
      } catch {
        // best-effort
      }
      return { ok: true, taskId: parsed.data.taskId };
    } catch (e) {
      return {
        ok: false,
        reason: "internal_error",
        message: e instanceof Error ? e.message : "No se pudo editar la tarea.",
      };
    }
  }, { source: "user_session" });
}

/** Elimina una tarea. */
export async function deleteTaskAction(raw: unknown): Promise<TaskActionResult> {
  const parsed = taskIdSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_input", message: "Parámetros inválidos." };
  }
  const access = await loadTaskWithAccess(parsed.data.taskId);
  if (!access.ok) return access.result;

  return withTenantContext(access.orgId, async () => {
    try {
      await deleteTask(parsed.data.taskId);
      try {
        await recordAuditEvent({
          actorUserId: access.userId,
          eventType: "opportunity_task_deleted",
          entityType: "opportunity",
          entityId: access.task.opportunity_id ?? access.task.id,
          payload: { task_id: parsed.data.taskId },
        });
      } catch {
        // best-effort
      }
      return { ok: true, taskId: parsed.data.taskId };
    } catch (e) {
      return {
        ok: false,
        reason: "internal_error",
        message: e instanceof Error ? e.message : "No se pudo eliminar la tarea.",
      };
    }
  }, { source: "user_session" });
}
