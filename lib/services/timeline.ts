import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { listPipelineStages } from "@/lib/db/pipeline";
import { TIMELINE_DEFAULT_LIMIT } from "@/lib/constants";
import {
  categoryOfKind,
  describeAuditEvent,
  type TimelineCategory,
  type TimelineKind,
} from "@/lib/services/timeline-catalog";
import type {
  ActivityRow,
  AuditLogRow,
  ISODateString,
  Json,
  OpportunityStageHistoryRow,
  OrderRow,
  PipelineStageRow,
  TaskRow,
  UUID,
} from "@/lib/types/database";

/**
 * Timeline unificado (M6 — B1).
 *
 * Patrón: fan-out paralelo por fuente, normalización a `TimelineEvent`
 * común, merge por `occurredAt DESC` y truncado a `limit`. Cada fuente
 * trae hasta `limit` eventos; el merger se queda con los más recientes.
 *
 * Fuentes activas en M6:
 *   - `opportunity_stage_history` — cambios de etapa (incluye seed,
 *     webhook, manual, automation, trigger_f1_f2, backfill).
 *   - `orders`                     — paid_at / cancelled_at.
 *   - `tasks`                      — created_at / completed_at.
 *   - `activities`                 — notas manuales (B9), eventos
 *                                     futuros de M8 sin retrabajo.
 *   - `audit_log`                  — solo event_types whitelisteados
 *                                     (reasignación, edit, sync exitoso,
 *                                     auto-creación C2, etc).
 *
 * Fuente preparada para M8 sin retrabajo:
 *   - `rule_executions` se agrega cuando M8 entre. La firma del merger
 *     no cambia — sólo se añade otro `from*` y se concatena.
 *
 * Explícitamente NO incluido:
 *   - Los mensajes de la CONVERSACIÓN de WhatsApp (viven en el iframe de
 *     Whaapy; la plataforma no los descarga). Sí aparecen los que la
 *     plataforma ENVIÓ — confirmación de entrega y encuesta de los 7 días.
 *   - Eventos técnicos de audit (sync_loop_prevented, *_intent_recorded,
 *     *_webhook_received, etc) — son ruido operativo, no para el vendedor.
 *     Medido en producción: el 90% del audit log es plomería de ese tipo.
 *     Qué entra y qué no lo decide `timeline-catalog.ts`, en un solo lugar.
 */

// `TimelineKind` y las categorías viven en `timeline-catalog.ts` — el mismo
// módulo que decide qué eventos entran, para que agregar uno sea un solo
// cambio en un solo archivo.
export type { TimelineCategory, TimelineKind };

export interface TimelineEvent {
  /** Identificador único en el merger: `<source>:<row_id>:<sub?>`. */
  id: string;
  /** Source que originó el evento — debug + tests. */
  source: "stage_history" | "orders" | "tasks" | "activities" | "audit";
  occurredAt: ISODateString;
  kind: TimelineKind;
  /** Agrupación para el filtro de la bitácora. */
  category: TimelineCategory;
  /** Resumen una-línea para la UI. */
  label: string;
  /** Detalle opcional (descripción del activity, nota libre, etc). */
  description: string | null;
  /** Payload semi-estructurado para drill-down o badge meta. */
  meta: Record<string, unknown>;
  actorUserId: UUID | null;
  /** Nombre del actor resuelto desde user_profiles (lote polish M6). */
  actorName: string | null;
  /** Opp asociada — útil para enlazar al popup desde el timeline. */
  opportunityId: UUID | null;
  /** Display reference de la opportunity (lote polish M6).
   *  Útil cuando un contacto tiene varias opps activas y el timeline
   *  unificado mezcla eventos de todas. */
  opportunityReference: string | null;
}

export interface TimelineQuery {
  /** Subject del timeline. Para contacto: todas las opps + orders +
   *  tareas + audits del contact. Para opp: scoped a esa opp. */
  scope: { contactId: UUID } | { opportunityId: UUID; contactId?: UUID };
  /** Eventos máximos a retornar. Default `TIMELINE_DEFAULT_LIMIT`. */
  limit?: number;
}

// ============================================================
// API pública
// ============================================================

export async function getContactTimeline(
  contactId: UUID,
  limit: number = TIMELINE_DEFAULT_LIMIT,
): Promise<TimelineEvent[]> {
  return buildTimeline({ scope: { contactId }, limit });
}

export async function getOpportunityTimeline(
  opportunityId: UUID,
  limit: number = TIMELINE_DEFAULT_LIMIT,
): Promise<TimelineEvent[]> {
  return buildTimeline({ scope: { opportunityId }, limit });
}

// ============================================================
// Construcción
// ============================================================

async function buildTimeline(q: TimelineQuery): Promise<TimelineEvent[]> {
  const limit = q.limit ?? TIMELINE_DEFAULT_LIMIT;

  // Las oportunidades del sujeto se resuelven UNA vez: las necesitan dos
  // fuentes (historial de etapas y auditoría), y la de auditoría sin ellas
  // deja fuera casi la mitad de la bitácora — ver `fetchAuditEvents`.
  const [stageMap, oppIds] = await Promise.all([
    loadStageNameMap(),
    resolveScopeOpportunityIds(q),
  ]);

  const [stageChanges, orders, tasks, activities, audits] = await Promise.all([
    fetchStageHistory(oppIds, limit, stageMap),
    fetchOrderEvents(q, limit),
    fetchTaskEvents(q, limit),
    fetchActivityEvents(q, limit),
    fetchAuditEvents(q, oppIds, limit),
  ]);

  const merged = [
    ...stageChanges,
    ...orders,
    ...tasks,
    ...activities,
    ...audits,
  ];
  merged.sort((a, b) => (b.occurredAt < a.occurredAt ? -1 : 1));
  const limited = merged.slice(0, limit);

  // Enriquecimiento del lote polish M6: resuelve actor names y opp
  // references en una sola pasada por timeline (no N+1).
  await enrichTimelineEvents(limited);
  return limited;
}

async function enrichTimelineEvents(events: TimelineEvent[]): Promise<void> {
  const userIds = new Set<UUID>();
  const oppIds = new Set<UUID>();
  for (const ev of events) {
    if (ev.actorUserId) userIds.add(ev.actorUserId);
    if (ev.opportunityId) oppIds.add(ev.opportunityId);
  }
  const [userMap, oppMap] = await Promise.all([
    userIds.size > 0 ? loadUserNamesMap(Array.from(userIds)) : Promise.resolve(new Map<UUID, string>()),
    oppIds.size > 0 ? loadOpportunityReferenceMap(Array.from(oppIds)) : Promise.resolve(new Map<UUID, string>()),
  ]);
  for (const ev of events) {
    if (ev.actorUserId) {
      ev.actorName = userMap.get(ev.actorUserId) ?? null;
    }
    if (ev.opportunityId) {
      ev.opportunityReference = oppMap.get(ev.opportunityId) ?? null;
    }
  }
}

async function loadUserNamesMap(userIds: UUID[]): Promise<Map<UUID, string>> {
  const { supabase } = getTenantScopedClient();
  // Trae user_profiles para el lookup base.
  const { data: profileData, error: profileError } = await supabase
    .from("user_profiles")
    .select("id, full_name, is_system_user")
    .in("id", userIds);
  if (profileError) throw profileError;

  const map = new Map<UUID, string>();
  for (const row of (profileData ?? []) as Array<{
    id: UUID;
    full_name: string;
    is_system_user: boolean;
  }>) {
    map.set(row.id, row.full_name);
  }

  // Correcciones ronda 2 — bug 5: el name declarado por el operador
  // vía `auth.users.raw_user_meta_data.full_name` se prioriza sobre
  // `user_profiles.full_name` si está presente. Esto permite que el
  // operador real "controle" cómo se le ve sin depender de un proceso
  // manual de UPDATE en user_profiles.
  try {
    // Cast a `any` para acceder al schema auth — los tipos de Database
    // hand-written no incluyen auth.users porque PostgREST lo expone
    // sólo bajo el rol service_role.
    const supabaseAny = supabase as unknown as {
      schema: (s: string) => {
        from: (t: string) => {
          select: (q: string) => {
            in: (
              col: string,
              ids: UUID[],
            ) => Promise<{
              data: Array<{
                id: UUID;
                raw_user_meta_data: Record<string, unknown> | null;
              }> | null;
              error: unknown;
            }>;
          };
        };
      };
    };
    const { data: authData, error: authError } = await supabaseAny
      .schema("auth")
      .from("users")
      .select("id, raw_user_meta_data")
      .in("id", userIds);
    if (!authError && Array.isArray(authData)) {
      for (const row of authData) {
        const metaName = row.raw_user_meta_data?.full_name;
        if (typeof metaName === "string" && metaName.trim().length > 0) {
          map.set(row.id, metaName.trim());
        }
      }
    }
  } catch {
    // Fallback silencioso: si auth no es accesible, seguimos con
    // user_profiles. Bug 5 documenta el SQL de actualización manual.
  }
  return map;
}

async function loadOpportunityReferenceMap(
  oppIds: UUID[],
): Promise<Map<UUID, string>> {
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("id, display_reference")
    .eq("organization_id", organizationId)
    .in("id", oppIds);
  if (error) throw error;
  const map = new Map<UUID, string>();
  for (const row of (data ?? []) as Array<{ id: UUID; display_reference: string | null }>) {
    if (row.display_reference) map.set(row.id, row.display_reference);
  }
  return map;
}

async function loadStageNameMap(): Promise<Map<UUID, PipelineStageRow>> {
  const stages = await listPipelineStages();
  const map = new Map<UUID, PipelineStageRow>();
  for (const s of stages) map.set(s.id, s);
  return map;
}

// ------------------------------------------------------------
// Oportunidades del sujeto
// ------------------------------------------------------------

/**
 * Las oportunidades que el timeline debe mirar. Para una oportunidad es ella
 * misma; para un contacto, TODAS las suyas — incluidas las canceladas, que
 * son parte de su historia (un lead archivado por absorción, una cotización
 * que Shopify borró).
 */
async function resolveScopeOpportunityIds(q: TimelineQuery): Promise<UUID[]> {
  if ("opportunityId" in q.scope) return [q.scope.opportunityId];
  const { supabase, organizationId } = getTenantScopedClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", q.scope.contactId);
  if (error) throw error;
  return (data ?? []).map((r) => (r as { id: UUID }).id);
}

// ------------------------------------------------------------
// stage_history
// ------------------------------------------------------------

async function fetchStageHistory(
  oppIds: UUID[],
  limit: number,
  stageMap: Map<UUID, PipelineStageRow>,
): Promise<TimelineEvent[]> {
  if (oppIds.length === 0) return [];
  const { supabase, organizationId } = getTenantScopedClient();

  const { data, error } = await supabase
    .from("opportunity_stage_history")
    .select("*")
    .eq("organization_id", organizationId)
    .in("opportunity_id", oppIds)
    .order("changed_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const rows = (data ?? []) as OpportunityStageHistoryRow[];
  return rows.map((row) => {
    const toStage = stageMap.get(row.to_stage_id);
    const fromStage = row.from_stage_id ? stageMap.get(row.from_stage_id) : null;
    const toName = toStage?.name ?? "etapa";
    const fromName = fromStage?.name ?? null;
    const label = fromName
      ? `Movida a "${toName}" desde "${fromName}"`
      : `Asignada a "${toName}"`;
    return {
      id: `stage_history:${row.id}`,
      source: "stage_history" as const,
      occurredAt: row.changed_at,
      kind: "stage_change" as const,
      category: categoryOfKind("stage_change"),
      label,
      description: null,
      meta: {
        from_stage_id: row.from_stage_id,
        to_stage_id: row.to_stage_id,
        from_stage_name: fromName,
        to_stage_name: toName,
        context: row.context,
        is_won: toStage?.is_won ?? false,
        is_lost: toStage?.is_lost ?? false,
      },
      actorUserId: row.changed_by_user_id,
      actorName: null,
      opportunityId: row.opportunity_id,
      opportunityReference: null,
    };
  });
}

// ------------------------------------------------------------
// orders
// ------------------------------------------------------------

async function fetchOrderEvents(
  q: TimelineQuery,
  limit: number,
): Promise<TimelineEvent[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("orders")
    .select("*")
    .eq("organization_id", organizationId);

  if ("opportunityId" in q.scope) {
    query = query.eq("opportunity_id", q.scope.opportunityId);
  } else {
    query = query.eq("contact_id", q.scope.contactId);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const rows = (data ?? []) as OrderRow[];
  const events: TimelineEvent[] = [];
  for (const row of rows) {
    if (row.paid_at) {
      events.push({
        id: `orders:paid:${row.id}`,
        source: "orders",
        occurredAt: row.paid_at,
        kind: "order_paid",
      category: categoryOfKind("order_paid"),
        label: `Orden ${row.shopify_name ?? row.shopify_order_id} pagada`,
        description: null,
        meta: {
          order_id: row.id,
          shopify_order_id: row.shopify_order_id,
          shopify_name: row.shopify_name,
          total_amount: row.total_amount,
          currency: row.currency,
          financial_status: row.financial_status,
        },
        actorUserId: null,
        actorName: null,
        opportunityId: row.opportunity_id,
        opportunityReference: null,
      });
    }
    if (row.cancelled_at) {
      events.push({
        id: `orders:cancelled:${row.id}`,
        source: "orders",
        occurredAt: row.cancelled_at,
        kind: "order_cancelled",
      category: categoryOfKind("order_cancelled"),
        label: `Orden ${row.shopify_name ?? row.shopify_order_id} cancelada`,
        description: row.cancellation_reason,
        meta: {
          order_id: row.id,
          shopify_order_id: row.shopify_order_id,
          cancellation_reason: row.cancellation_reason,
        },
        actorUserId: null,
        actorName: null,
        opportunityId: row.opportunity_id,
        opportunityReference: null,
      });
    }
  }
  return events;
}

// ------------------------------------------------------------
// tasks
// ------------------------------------------------------------

async function fetchTaskEvents(
  q: TimelineQuery,
  limit: number,
): Promise<TimelineEvent[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("tasks")
    .select("*")
    .eq("organization_id", organizationId);

  if ("opportunityId" in q.scope) {
    query = query.eq("opportunity_id", q.scope.opportunityId);
  } else {
    query = query.eq("contact_id", q.scope.contactId);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const rows = (data ?? []) as TaskRow[];
  const events: TimelineEvent[] = [];
  for (const row of rows) {
    events.push({
      id: `tasks:created:${row.id}`,
      source: "tasks",
      occurredAt: row.created_at,
      kind: "task_created",
      category: categoryOfKind("task_created"),
      label: `Tarea creada: ${row.title}`,
      description: row.description,
      meta: {
        task_id: row.id,
        task_type: row.task_type,
        status: row.status,
        due_at: row.due_at,
        assigned_user_id: row.assigned_user_id,
      },
      actorUserId: row.assigned_user_id,
      actorName: null,
      opportunityId: row.opportunity_id,
      opportunityReference: null,
    });
    if (row.completed_at) {
      events.push({
        id: `tasks:completed:${row.id}`,
        source: "tasks",
        occurredAt: row.completed_at,
        kind: "task_completed",
        category: categoryOfKind("task_completed"),
        label: `Tarea completada: ${row.title}`,
        description: null,
        meta: { task_id: row.id, task_type: row.task_type },
        actorUserId: row.assigned_user_id,
        actorName: null,
        opportunityId: row.opportunity_id,
        opportunityReference: null,
      });
    }
  }
  return events;
}

// ------------------------------------------------------------
// activities
// ------------------------------------------------------------

async function fetchActivityEvents(
  q: TimelineQuery,
  limit: number,
): Promise<TimelineEvent[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("activities")
    .select("*")
    .eq("organization_id", organizationId);

  if ("opportunityId" in q.scope) {
    query = query.eq("opportunity_id", q.scope.opportunityId);
  } else {
    query = query.eq("contact_id", q.scope.contactId);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const rows = (data ?? []) as ActivityRow[];
  return rows.map((row) => activityToEvent(row));
}

function activityToEvent(row: ActivityRow): TimelineEvent {
  const kind: TimelineKind =
    row.activity_type === "manual_note"
      ? "manual_note"
      : row.activity_type === "lead_message"
        ? "lead_message"
        : "other_activity";
  return {
    id: `activities:${row.id}`,
    source: "activities",
    occurredAt: row.created_at,
    kind,
    category: categoryOfKind(kind),
    label: row.description,
    description: null,
    meta: {
      activity_type: row.activity_type,
      ...(typeof row.payload === "object" && row.payload !== null
        ? (row.payload as Record<string, unknown>)
        : {}),
    },
    actorUserId: row.triggered_by_user_id,
    actorName: null,
    opportunityId: row.opportunity_id,
    opportunityReference: null,
  };
}

// ------------------------------------------------------------
// audit_log (whitelisted)
// ------------------------------------------------------------

async function fetchAuditEvents(
  q: TimelineQuery,
  oppIds: UUID[],
  limit: number,
): Promise<TimelineEvent[]> {
  const { supabase, organizationId } = getTenantScopedClient();

  // Sin filtro de event_type en SQL: el catálogo es chico y PostgREST no
  // compone bien un `.in()` grande de texto. Se sobre-pide porque el 90%
  // del audit log es plomería que se descarta aquí.
  const over = limit * 6;
  const base = () =>
    supabase
      .from("audit_log")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(over);

  // DOS lecturas, no una. La mitad de los hechos del negocio se registran
  // contra la OPORTUNIDAD (`entity_type = 'opportunity'`), no contra el
  // contacto: la confirmación de entrega enviada, la encuesta, el caso
  // resuelto, el lead absorbido, la reasignación. Medido en producción: 844
  // eventos de negocio, el 43% del total, que la bitácora del contacto no
  // mostraba por mirar solo `entity_type = 'contact'`.
  const queries = [
    "opportunityId" in q.scope
      ? base().eq("entity_type", "opportunity").eq("entity_id", q.scope.opportunityId)
      : base().eq("entity_type", "contact").eq("entity_id", q.scope.contactId),
  ];
  if (!("opportunityId" in q.scope) && oppIds.length > 0) {
    queries.push(base().eq("entity_type", "opportunity").in("entity_id", oppIds));
  }

  const results = await Promise.all(queries);
  const rows: AuditLogRow[] = [];
  const seen = new Set<string>();
  for (const res of results) {
    if (res.error) throw res.error;
    for (const row of (res.data ?? []) as AuditLogRow[]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  rows.sort((a, b) => (b.created_at < a.created_at ? -1 : 1));

  const events: TimelineEvent[] = [];
  for (const row of rows) {
    const event = auditToEvent(row);
    // `null` = no está en el catálogo, o sea: no es un hecho del negocio.
    if (!event) continue;
    events.push(event);
    if (events.length >= limit) break;
  }
  return events;
}

function auditToEvent(row: AuditLogRow): TimelineEvent | null {
  const payload = (typeof row.payload === "object" && row.payload !== null
    ? (row.payload as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const described = describeAuditEvent(row.event_type, payload);
  if (!described) return null;

  // Para reasignaciones la entidad ancla puede ser contact u opportunity
  // — usamos el entity_id como opportunityId solo si entity_type lo es.
  const opportunityId =
    row.entity_type === "opportunity" ? (row.entity_id as UUID | null) : null;

  return {
    id: `audit:${row.id}`,
    source: "audit",
    occurredAt: row.created_at,
    kind: described.kind,
    category: described.category,
    label: described.label,
    description: null,
    meta: { event_type: row.event_type, ...payload },
    actorUserId: row.actor_user_id,
    actorName: null,
    opportunityId,
    opportunityReference: null,
  };
}

export type { Json };
