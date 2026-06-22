"use server";
import { cookies } from "next/headers";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/tenant/context";
import {
  countKanbanOpportunitiesByStage,
  getKanbanOpportunityById,
  getOpportunityById,
  listKanbanOpportunities,
  searchContactIdsForQuery,
  searchOpportunitiesAnyState,
  type KanbanOpportunity,
  type ReopenSearchRow,
} from "@/lib/db/opportunities";
import { reopenOpportunityIntoProblemCase } from "@/lib/services/opportunity-reopen";
import { listPendingTaskCountsByOpportunity, recordAuditEvent } from "@/lib/db/operational";
import { listLossReasons, listPipelineStages } from "@/lib/db/pipeline";
import { getMembership, listActiveRealVendors } from "@/lib/db/users";
import { getOrganizationById, updateOrganization } from "@/lib/db/organizations";
import {
  moveOpportunityStage,
  type MoveOpportunityResult,
} from "@/lib/services/pipeline-move";
import {
  closedFilterForStage,
  computeClosedCutoffIso,
  computeClosedListRetentionCutoffIso,
  partitionClosedStages,
  readHideClosedDays,
  sanitizeHideClosedDays,
} from "@/lib/services/pipeline-visibility";
import { resolvePostventaStages } from "@/lib/services/dashboard-stages";
import { FUNNELS, PIPELINE_FUNNEL_COOKIE, PIPELINE_PAGE_SIZE, PIPELINE_UNASSIGNED_COOKIE } from "@/lib/constants";
import type { Funnel, Json, UUID } from "@/lib/types/database";
import type {
  FetchOppActionResult,
  LoadPageActionResult,
  MoveStageActionResult,
  PipelineInitialState,
  ReopenOpportunityActionResult,
  ReopenSearchResultItem,
  SearchOpportunitiesForReopenResult,
} from "@/lib/types/pipeline";

/**
 * Server actions del pipeline kanban (M5).
 *
 * Convención: cada action resuelve sesión + tenant context al
 * principio. Si no hay sesión válida, retorna error en formato
 * uniforme `{ ok: false, ... }`. La UI no debe asumir success.
 *
 * NO se exporta nada que pueda usarse desde Client Components con
 * datos no validados; los inputs siempre pasan por Zod en el handler.
 */

const moveStageSchema = z.object({
  opportunityId: z.string().uuid(),
  toStageId: z.string().uuid(),
  expectedLastModifiedAt: z.string().min(1),
  lossReasonId: z.string().uuid().nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

/**
 * Mueve una oportunidad de etapa por acción manual del usuario.
 * Encadena: validación → optimistic-locked UPDATE → audit → history
 * (ver `lib/services/pipeline-move.ts`).
 *
 * Retorna la opp completa (con contact embebido) para que la UI
 * pueda confirmar la actualización sin re-fetch.
 */
export async function moveStageAction(
  raw: unknown,
): Promise<MoveStageActionResult> {
  const parsed = moveStageSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_input",
      message: "Datos inválidos para mover la oportunidad.",
    };
  }
  const input = parsed.data;

  const session = await getSession();
  if (session.status !== "ok") {
    return {
      ok: false,
      reason: "no_session",
      message: "Sesión expirada. Vuelve a iniciar sesión.",
    };
  }

  const orgId = session.data.activeOrg.id;
  const userId = session.data.userId;

  return withTenantContext(orgId, async () => {
    const result: MoveOpportunityResult = await moveOpportunityStage({
      opportunityId: input.opportunityId,
      toStageId: input.toStageId,
      expectedLastModifiedAt: input.expectedLastModifiedAt,
      actorUserId: userId,
      context: "manual",
      lossReasonId: input.lossReasonId ?? null,
      note: input.note ?? null,
    });

    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        message: result.message,
      };
    }

    const refreshed = await getKanbanOpportunityById(result.opportunity.id);
    if (!refreshed) {
      return {
        ok: false,
        reason: "post_move_not_found",
        message: "La oportunidad fue movida pero no se pudo refrescar la vista.",
      };
    }

    return { ok: true, opportunity: refreshed };
  }, { source: "user_session" });
}

const loadPageSchema = z.object({
  funnel: z.enum(FUNNELS),
  stageId: z.string().uuid(),
  page: z.number().int().nonnegative(),
  /**
   * - undefined → admin sin filtro (ve todo)
   * - null → admin con filtro "Sin asignar"
   * - UUID → vendedor (sus propias) o admin filtrando por advisor
   */
  assignedAdvisorId: z.union([z.string().uuid(), z.null()]).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  query: z.string().max(200).optional(),
  /** "Ver cerradas": si true, NO aplica el filtro de auto-ocultar para
   *  esta etapa cerrada → trae también las cerradas viejas. */
  showClosed: z.boolean().optional(),
  /** Vista "Casos resueltos" (Post-venta): "resolved" trae solo los
   *  casos archivados; default/"active" excluye los resueltos. */
  resolvedScope: z.enum(["active", "resolved"]).optional(),
});

/**
 * Carga una página adicional de cards para una columna del kanban
 * (paginación server-side al hacer scroll al final).
 */
export async function loadKanbanPageAction(
  raw: unknown,
): Promise<LoadPageActionResult> {
  const parsed = loadPageSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_input",
      message: "Parámetros de paginación inválidos.",
    };
  }
  const input = parsed.data;

  const session = await getSession();
  if (session.status !== "ok") {
    return {
      ok: false,
      reason: "no_session",
      message: "Sesión expirada.",
    };
  }

  const orgId = session.data.activeOrg.id;
  const role = session.data.activeOrg.role;
  const isAdmin = role === "admin" || role === "superadmin";

  // Defensa multi-tenant + role: si el caller es vendedor, ignorar
  // `assignedAdvisorId` explícito y forzar al membership del usuario.
  return withTenantContext(orgId, async () => {
    let effectiveAdvisorId: UUID | null | undefined;
    if (!isAdmin) {
      const membership = await getMembership(session.data.userId, orgId);
      if (!membership) {
        return {
          ok: false,
          reason: "no_membership",
          message: "No tienes acceso a esta organización.",
        };
      }
      effectiveAdvisorId = membership.id;
    } else {
      effectiveAdvisorId = input.assignedAdvisorId;
    }

    const matchingContactIds: UUID[] | null =
      input.query && input.query.trim().length > 0
        ? await searchContactIdsForQuery(input.query)
        : null;

    // Ventana de cerradas por etapa cerrada (M4v2 dos umbrales):
    //   - Vista normal: corte de auto-ocultar (N días, config de la org).
    //   - "Ver cerradas": corte de retención (30 días) — ya NO trae todo
    //     el histórico, solo lo archivado en los últimos 30 días.
    const retentionCutoffIso = computeClosedListRetentionCutoffIso();
    let closedFilter: { column: "won_at" | "lost_at"; sinceIso: string } | null =
      null;
    const [org, stages] = await Promise.all([
      getOrganizationById(orgId),
      listPipelineStages(input.funnel),
    ]);
    const stage = stages.find((s) => s.id === input.stageId);
    if (stage) {
      const cutoff = input.showClosed
        ? retentionCutoffIso
        : computeClosedCutoffIso(readHideClosedDays(org?.config ?? null));
      closedFilter = closedFilterForStage(stage, cutoff);
    }
    const resolvedSinceIso =
      input.resolvedScope === "resolved" ? retentionCutoffIso : null;

    const items = await listKanbanOpportunities({
      funnel: input.funnel,
      stageId: input.stageId,
      assignedAdvisorId: effectiveAdvisorId,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      query: input.query,
      matchingContactIds,
      limit: PIPELINE_PAGE_SIZE + 1,
      offset: input.page * PIPELINE_PAGE_SIZE,
      closedFilter,
      resolvedScope: input.resolvedScope,
      resolvedSinceIso,
    });
    const hasMore = items.length > PIPELINE_PAGE_SIZE;
    return {
      ok: true,
      items: hasMore ? items.slice(0, PIPELINE_PAGE_SIZE) : items,
      hasMore,
    };
  }, { source: "user_session" });
}

const fetchOppByIdSchema = z.object({
  opportunityId: z.string().uuid(),
});

/**
 * Resuelve una sola opp por id — usada por el cliente cuando Realtime
 * emite un evento UPDATE/INSERT cuyo payload no incluye el contact
 * embebido. La UI dispara este action y reemplaza la card en estado.
 */
export async function fetchKanbanOpportunityAction(
  raw: unknown,
): Promise<FetchOppActionResult> {
  const parsed = fetchOppByIdSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_input",
      message: "Parámetros inválidos.",
    };
  }
  const session = await getSession();
  if (session.status !== "ok") {
    return {
      ok: false,
      reason: "no_session",
      message: "Sesión expirada.",
    };
  }
  const orgId = session.data.activeOrg.id;
  return withTenantContext(orgId, async () => {
    const opp = await getKanbanOpportunityById(parsed.data.opportunityId);
    return { ok: true, opportunity: opp };
  }, { source: "user_session" });
}

// ============================================================
// Reapertura de oportunidades a "Caso problemático" (M4v2, Bloque D)
// ============================================================

const searchReopenSchema = z.object({
  query: z.string().min(1).max(200),
});

function deriveReopenStatusLabel(row: ReopenSearchRow): string {
  if (row.cancelled_at) return "Cancelada";
  if (row.resolved_at) return "Resuelto";
  if (row.won_at) return row.funnel === "venta" ? "Ganada" : "Caso cerrado";
  if (row.lost_at) return "Perdida";
  return "Activa";
}

/**
 * Búsqueda transversal para el botón "+" de reapertura: encuentra opps
 * en CUALQUIER etapa/funnel, incluidas cerradas/canceladas/resueltas.
 * Scope por asesor para vendedores (defensa a nivel data).
 */
export async function searchOpportunitiesForReopenAction(
  raw: unknown,
): Promise<SearchOpportunitiesForReopenResult> {
  const parsed = searchReopenSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_input", message: "Búsqueda inválida." };
  }
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, reason: "no_session", message: "Sesión expirada." };
  }
  const orgId = session.data.activeOrg.id;
  const role = session.data.activeOrg.role;
  const isAdmin = role === "admin" || role === "superadmin";

  return withTenantContext(orgId, async () => {
    let assignedAdvisorId: UUID | undefined;
    if (!isAdmin) {
      const membership = await getMembership(session.data.userId, orgId);
      if (!membership) {
        return { ok: false, reason: "no_membership", message: "Sin acceso." } as const;
      }
      assignedAdvisorId = membership.id;
    }

    const rows = await searchOpportunitiesAnyState({
      query: parsed.data.query,
      assignedAdvisorId,
      limit: 25,
    });
    const results: ReopenSearchResultItem[] = rows.map((r) => ({
      id: r.id,
      funnel: r.funnel,
      stageName: r.stage_name,
      contactName:
        r.contact?.full_name?.trim() ||
        r.contact?.phone?.trim() ||
        "Sin nombre",
      reference: r.display_reference ?? r.shopify_order_id ?? null,
      statusLabel: deriveReopenStatusLabel(r),
      lastModifiedAt: r.last_modified_at,
    }));
    return { ok: true, results } as const;
  }, { source: "user_session" });
}

const reopenSchema = z.object({
  opportunityId: z.string().uuid(),
});

/**
 * Reabre una oportunidad hacia "Caso problemático" (flujo híbrido en
 * `reopenOpportunityIntoProblemCase`). Permiso: admin, o el vendedor
 * dueño de la opp (defensa — la búsqueda ya lo scopea, pero el id llega
 * del cliente y se re-valida aquí).
 */
export async function reopenOpportunityAction(
  raw: unknown,
): Promise<ReopenOpportunityActionResult> {
  const parsed = reopenSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_input", message: "Parámetros inválidos." };
  }
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, reason: "no_session", message: "Sesión expirada." };
  }
  const orgId = session.data.activeOrg.id;
  const role = session.data.activeOrg.role;
  const isAdmin = role === "admin" || role === "superadmin";

  return withTenantContext(orgId, async () => {
    const opp = await getOpportunityById(parsed.data.opportunityId);
    if (!opp) {
      return { ok: false, reason: "not_found", message: "La oportunidad ya no existe." } as const;
    }
    let actorUserId: UUID | null = session.data.userId;
    if (!isAdmin) {
      const membership = await getMembership(session.data.userId, orgId);
      if (!membership || opp.assigned_advisor_id !== membership.id) {
        // No filtra IDs: mismo mensaje que "no existe".
        return { ok: false, reason: "forbidden", message: "No tienes acceso a esta oportunidad." } as const;
      }
      actorUserId = session.data.userId;
    }

    const res = await reopenOpportunityIntoProblemCase({
      opportunityId: parsed.data.opportunityId,
      actorUserId,
    });
    if (!res.ok) {
      return { ok: false, reason: res.reason, message: res.message } as const;
    }
    return { ok: true, opportunityId: res.opportunityId, mode: res.mode } as const;
  }, { source: "user_session" });
}

/**
 * Persiste el funnel activo del usuario como preferencia. Sin
 * `user_profiles.preferences` en M1, usamos cookie httpOnly. El
 * scope es por usuario porque la cookie vive en su navegador
 * autenticado.
 */
export async function setActiveFunnelPreference(funnel: Funnel): Promise<void> {
  if (!FUNNELS.includes(funnel)) return;
  cookies().set(PIPELINE_FUNNEL_COOKIE, funnel, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

/**
 * Persiste el filtro admin "Sin asignar" para que se conserve entre
 * navegaciones. Solo se usa cuando role es admin/superadmin.
 */
export async function setUnassignedFilterPreference(
  enabled: boolean,
): Promise<void> {
  cookies().set(PIPELINE_UNASSIGNED_COOKIE, enabled ? "1" : "0", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export interface PipelineFilters {
  /** ISO date string (yyyy-mm-dd o full ISO) inclusivo. */
  dateFrom?: string;
  dateTo?: string;
  /** Filtra por asesor (UUID de membership). Solo admin/superadmin. */
  advisorId?: UUID;
  /** Búsqueda libre sobre display_reference y contact name/phone. */
  query?: string;
  /** Vista "Casos resueltos" (Post-venta): "resolved" muestra solo el
   *  archivo de casos cerrados; default excluye los resueltos. */
  resolvedScope?: "active" | "resolved";
}

/**
 * Server-side helper: arma el snapshot inicial del pipeline para
 * pintar en el primer render del Server Component. Carga (en
 * paralelo) las stages del funnel activo + la primera page de cada
 * columna. NO incluye Realtime — eso lo monta el Client Component.
 */
export async function loadInitialPipelineState(opts: {
  funnel: Funnel;
  unassignedFilter: boolean;
  filters?: PipelineFilters;
}): Promise<{ ok: true; state: PipelineInitialState } | { ok: false; reason: string }> {
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, reason: "no_session" };
  }
  const orgId = session.data.activeOrg.id;
  const role = session.data.activeOrg.role;
  const isAdmin = role === "admin" || role === "superadmin";

  return withTenantContext(orgId, async () => {
    let effectiveAdvisorId: UUID | null | undefined;
    if (!isAdmin) {
      const membership = await getMembership(session.data.userId, orgId);
      if (!membership) {
        return { ok: false, reason: "no_membership" } as const;
      }
      effectiveAdvisorId = membership.id;
    } else {
      // Filtro admin: si pasa advisorId explícito, prevalece sobre unassigned.
      if (opts.filters?.advisorId) {
        effectiveAdvisorId = opts.filters.advisorId;
      } else if (opts.unassignedFilter) {
        effectiveAdvisorId = null;
      } else {
        effectiveAdvisorId = undefined;
      }
    }

    const filterDateFrom = opts.filters?.dateFrom;
    const filterDateTo = opts.filters?.dateTo;
    const filterQuery = opts.filters?.query;
    const resolvedScope = opts.filters?.resolvedScope;

    // Pre-resolve contact_ids that match the search query ONCE. Both
    // the count query and the per-stage list queries reuse this set
    // — sin esto, cada stage volvía a correr la sub-query de contacts.
    const matchingContactIds: UUID[] | null =
      filterQuery && filterQuery.trim().length > 0
        ? await searchContactIdsForQuery(filterQuery)
        : null;

    const [allStages, vendors, lossReasons, org] = await Promise.all([
      listPipelineStages(opts.funnel),
      listActiveRealVendors(orgId),
      listLossReasons({ activeOnly: true }),
      getOrganizationById(orgId),
    ]);
    const activeStages = allStages.filter((s) => s.is_active);

    // Auto-ocultar cerradas (Fix de pipeline P1): umbral global de la
    // org (default 7) → instante de corte. Las etapas cerradas se
    // filtran por su fecha de cierre; las activas no se tocan.
    const hideClosedAfterDays = readHideClosedDays(org?.config ?? null);
    const cutoffIso = computeClosedCutoffIso(hideClosedAfterDays);
    // Retención de la lista de cerradas/resueltas (M4v2): 30 días en CDMX.
    const retentionCutoffIso = computeClosedListRetentionCutoffIso();
    const resolvedSinceIso =
      resolvedScope === "resolved" ? retentionCutoffIso : null;
    const { wonStageIds, lostStageIds } = partitionClosedStages(activeStages);

    const [countResult, pageResults] = await Promise.all([
      countKanbanOpportunitiesByStage({
        funnel: opts.funnel,
        assignedAdvisorId: effectiveAdvisorId,
        dateFrom: filterDateFrom,
        dateTo: filterDateTo,
        query: filterQuery,
        matchingContactIds,
        closedHide: { cutoffIso, retentionCutoffIso, wonStageIds, lostStageIds },
        resolvedScope,
        resolvedSinceIso,
      }),
      Promise.all(
        activeStages.map(async (stage) => {
          const items = await listKanbanOpportunities({
            funnel: opts.funnel,
            stageId: stage.id,
            assignedAdvisorId: effectiveAdvisorId,
            dateFrom: filterDateFrom,
            dateTo: filterDateTo,
            query: filterQuery,
            matchingContactIds,
            limit: PIPELINE_PAGE_SIZE + 1,
            closedFilter: closedFilterForStage(stage, cutoffIso),
            resolvedScope,
            resolvedSinceIso,
          });
          return { stageId: stage.id, items };
        }),
      ),
    ]);
    const countsByStage = countResult.counts;
    const hiddenClosedByStage = countResult.hiddenCounts;

    const cardsByStage: Record<UUID, KanbanOpportunity[]> = {};
    const hasMoreByStage: Record<UUID, boolean> = {};
    const allOppIds: UUID[] = [];
    for (const { stageId, items } of pageResults) {
      const hasMore = items.length > PIPELINE_PAGE_SIZE;
      const sliced = hasMore ? items.slice(0, PIPELINE_PAGE_SIZE) : items;
      cardsByStage[stageId] = sliced;
      hasMoreByStage[stageId] = hasMore;
      for (const o of sliced) allOppIds.push(o.id);
    }

    const pendingMap = await listPendingTaskCountsByOpportunity(allOppIds);
    const pendingTasksByOpp: Record<UUID, number> = {};
    pendingMap.forEach((count, oppId) => { pendingTasksByOpp[oppId] = count; });

    // Ancla canónica de "Caso problemático" (solo Post-venta) — habilita el
    // botón "Caso resuelto" en el card sin acoplarse al nombre (M4v2).
    const problematicStageId =
      opts.funnel === "post_venta"
        ? (await resolvePostventaStages()).problematicStage?.id ?? null
        : null;

    return {
      ok: true,
      state: {
        funnel: opts.funnel,
        stages: activeStages,
        cardsByStage,
        hasMoreByStage,
        countsByStage,
        hiddenClosedByStage,
        hideClosedAfterDays,
        pendingTasksByOpp,
        problematicStageId,
        effectiveAdvisorId,
        advisors: vendors.map((v) => ({
          membershipId: v.id,
          userId: v.user_id,
          fullName: v.profile.full_name,
          color: v.profile.color,
        })),
        lossReasons: lossReasons.map((lr) => ({ id: lr.id, name: lr.name })),
      },
    } as const;
  }, { source: "user_session" });
}

/**
 * Lee la preferencia de funnel del usuario desde cookie. Default
 * `'venta'` si no hay cookie todavía.
 */
export async function readFunnelPreference(): Promise<Funnel> {
  const cookie = cookies().get(PIPELINE_FUNNEL_COOKIE)?.value;
  if (cookie && (FUNNELS as readonly string[]).includes(cookie)) {
    return cookie as Funnel;
  }
  return "venta";
}

export async function readUnassignedFilterPreference(): Promise<boolean> {
  return cookies().get(PIPELINE_UNASSIGNED_COOKIE)?.value === "1";
}

const setHideClosedDaysSchema = z.object({
  days: z.number().int(),
});

export type SetHideClosedDaysResult =
  | { ok: true; days: number }
  | { ok: false; reason: string; message: string };

/**
 * Ajusta el umbral global de auto-ocultar cerradas
 * (`organizations.config.pipeline.hide_closed_after_days`). Solo admin.
 * Es un ajuste de visualización del kanban — no toca opps ni KPIs.
 *
 * Vive en el pipeline (no en un módulo de Ajustes — Umbrales se difirió
 * a V2): el control del pipeline llama a esta action y luego recarga el
 * estado para re-aplicar el filtro con el nuevo valor.
 */
export async function setHideClosedDaysAction(
  raw: unknown,
): Promise<SetHideClosedDaysResult> {
  const parsed = setHideClosedDaysSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_input", message: "Valor inválido." };
  }
  const session = await getSession();
  if (session.status !== "ok") {
    return { ok: false, reason: "no_session", message: "Sesión expirada." };
  }
  const role = session.data.activeOrg.role;
  const isAdmin = role === "admin" || role === "superadmin";
  if (!isAdmin) {
    return {
      ok: false,
      reason: "forbidden",
      message: "Solo un administrador puede cambiar este ajuste.",
    };
  }
  const orgId = session.data.activeOrg.id;
  const days = sanitizeHideClosedDays(parsed.data.days);

  return withTenantContext(orgId, async () => {
    const org = await getOrganizationById(orgId);
    if (!org) {
      return { ok: false, reason: "org_not_found", message: "Organización no encontrada." } as const;
    }
    const baseConfig: Record<string, Json> =
      org.config && typeof org.config === "object" && !Array.isArray(org.config)
        ? { ...(org.config as Record<string, Json>) }
        : {};
    const basePipeline: Record<string, Json> =
      baseConfig.pipeline &&
      typeof baseConfig.pipeline === "object" &&
      !Array.isArray(baseConfig.pipeline)
        ? { ...(baseConfig.pipeline as Record<string, Json>) }
        : {};
    basePipeline.hide_closed_after_days = days;
    baseConfig.pipeline = basePipeline as Json;
    await updateOrganization(orgId, { config: baseConfig as Json });
    await recordAuditEvent({
      actorUserId: session.data.userId,
      eventType: "pipeline_hide_closed_days_changed",
      entityType: "organization",
      entityId: orgId,
      payload: { hide_closed_after_days: days },
    });
    return { ok: true, days } as const;
  }, { source: "user_session" });
}
