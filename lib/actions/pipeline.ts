"use server";
import { cookies } from "next/headers";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/tenant/context";
import {
  countKanbanOpportunitiesByStage,
  getKanbanOpportunityById,
  listKanbanOpportunities,
  searchContactIdsForQuery,
  type KanbanOpportunity,
} from "@/lib/db/opportunities";
import { listPendingTaskCountsByOpportunity } from "@/lib/db/operational";
import { listLossReasons, listPipelineStages } from "@/lib/db/pipeline";
import { getMembership, listActiveRealVendors } from "@/lib/db/users";
import {
  moveOpportunityStage,
  type MoveOpportunityResult,
} from "@/lib/services/pipeline-move";
import { FUNNELS, PIPELINE_FUNNEL_COOKIE, PIPELINE_PAGE_SIZE, PIPELINE_UNASSIGNED_COOKIE } from "@/lib/constants";
import type { Funnel, UUID } from "@/lib/types/database";
import type {
  FetchOppActionResult,
  LoadPageActionResult,
  MoveStageActionResult,
  PipelineInitialState,
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

    // Pre-resolve contact_ids that match the search query ONCE. Both
    // the count query and the per-stage list queries reuse this set
    // — sin esto, cada stage volvía a correr la sub-query de contacts.
    const matchingContactIds: UUID[] | null =
      filterQuery && filterQuery.trim().length > 0
        ? await searchContactIdsForQuery(filterQuery)
        : null;

    const [allStages, vendors, lossReasons, countsByStage] = await Promise.all([
      listPipelineStages(opts.funnel),
      listActiveRealVendors(orgId),
      listLossReasons({ activeOnly: true }),
      countKanbanOpportunitiesByStage({
        funnel: opts.funnel,
        assignedAdvisorId: effectiveAdvisorId,
        dateFrom: filterDateFrom,
        dateTo: filterDateTo,
        query: filterQuery,
        matchingContactIds,
      }),
    ]);
    const activeStages = allStages.filter((s) => s.is_active);

    const pageResults = await Promise.all(
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
        });
        return { stageId: stage.id, items };
      }),
    );

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

    return {
      ok: true,
      state: {
        funnel: opts.funnel,
        stages: activeStages,
        cardsByStage,
        hasMoreByStage,
        countsByStage,
        pendingTasksByOpp,
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
