import "server-only";
import { getTenantScopedClient } from "@/lib/db/client";
import { listPipelineStages } from "@/lib/db/pipeline";
import { TIMELINE_DEFAULT_LIMIT } from "@/lib/constants";
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
 *   - Mensajes de Whaapy (viven en el iframe — Sección B10 del prompt).
 *   - Eventos técnicos de audit (sync_loop_prevented, *_intent_recorded,
 *     *_sync_failed, etc) — son ruido operativo, no para el vendedor.
 */

export type TimelineKind =
  | "stage_change"
  | "order_paid"
  | "order_cancelled"
  | "task_created"
  | "task_completed"
  | "manual_note"
  | "reassignment"
  | "contact_edited"
  | "contact_created_in_shopify"
  | "contact_matched_in_shopify"
  | "contact_created_in_whaapy"
  | "opportunity_auto_created"
  | "other_activity"
  | "other_audit";

export interface TimelineEvent {
  /** Identificador único en el merger: `<source>:<row_id>:<sub?>`. */
  id: string;
  /** Source que originó el evento — debug + tests. */
  source: "stage_history" | "orders" | "tasks" | "activities" | "audit";
  occurredAt: ISODateString;
  kind: TimelineKind;
  /** Resumen una-línea para la UI. */
  label: string;
  /** Detalle opcional (descripción del activity, nota libre, etc). */
  description: string | null;
  /** Payload semi-estructurado para drill-down o badge meta. */
  meta: Record<string, unknown>;
  actorUserId: UUID | null;
  /** Opp asociada — útil para enlazar al popup desde el timeline. */
  opportunityId: UUID | null;
}

export interface TimelineQuery {
  /** Subject del timeline. Para contacto: todas las opps + orders +
   *  tareas + audits del contact. Para opp: scoped a esa opp. */
  scope: { contactId: UUID } | { opportunityId: UUID; contactId?: UUID };
  /** Eventos máximos a retornar. Default `TIMELINE_DEFAULT_LIMIT`. */
  limit?: number;
}

/**
 * Event types del audit_log que SÍ entran al timeline. Mantener tan
 * corta como sea posible — todo lo que no esté acá se ignora.
 * Si M7+ necesita exponer más eventos al vendedor, agregar acá.
 */
const AUDIT_EVENT_WHITELIST = new Set<string>([
  "contact_reassigned",
  "opportunity_reassigned",
  "contact_edited_manually",
  "shopify_customer_created_outbound",
  "shopify_customer_matched_existing_on_create",
  "whaapy_contact_created_outbound",
  "whaapy_contact_matched_existing_on_create",
  "c2_opportunity_auto_created",
]);

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

  const stageMap = await loadStageNameMap();

  const [stageChanges, orders, tasks, activities, audits] = await Promise.all([
    fetchStageHistory(q, limit, stageMap),
    fetchOrderEvents(q, limit),
    fetchTaskEvents(q, limit),
    fetchActivityEvents(q, limit),
    fetchAuditEvents(q, limit),
  ]);

  const merged = [
    ...stageChanges,
    ...orders,
    ...tasks,
    ...activities,
    ...audits,
  ];
  merged.sort((a, b) => (b.occurredAt < a.occurredAt ? -1 : 1));
  return merged.slice(0, limit);
}

async function loadStageNameMap(): Promise<Map<UUID, PipelineStageRow>> {
  const stages = await listPipelineStages();
  const map = new Map<UUID, PipelineStageRow>();
  for (const s of stages) map.set(s.id, s);
  return map;
}

// ------------------------------------------------------------
// stage_history
// ------------------------------------------------------------

async function fetchStageHistory(
  q: TimelineQuery,
  limit: number,
  stageMap: Map<UUID, PipelineStageRow>,
): Promise<TimelineEvent[]> {
  const { supabase, organizationId } = getTenantScopedClient();

  let oppIds: UUID[];
  if ("opportunityId" in q.scope) {
    oppIds = [q.scope.opportunityId];
  } else {
    // Para timeline de contacto: traer ids de opps del contacto.
    const { data, error } = await supabase
      .from("opportunities")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("contact_id", q.scope.contactId);
    if (error) throw error;
    oppIds = (data ?? []).map((r) => (r as { id: UUID }).id);
    if (oppIds.length === 0) return [];
  }

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
      opportunityId: row.opportunity_id,
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
        opportunityId: row.opportunity_id,
      });
    }
    if (row.cancelled_at) {
      events.push({
        id: `orders:cancelled:${row.id}`,
        source: "orders",
        occurredAt: row.cancelled_at,
        kind: "order_cancelled",
        label: `Orden ${row.shopify_name ?? row.shopify_order_id} cancelada`,
        description: row.cancellation_reason,
        meta: {
          order_id: row.id,
          shopify_order_id: row.shopify_order_id,
          cancellation_reason: row.cancellation_reason,
        },
        actorUserId: null,
        opportunityId: row.opportunity_id,
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
      opportunityId: row.opportunity_id,
    });
    if (row.completed_at) {
      events.push({
        id: `tasks:completed:${row.id}`,
        source: "tasks",
        occurredAt: row.completed_at,
        kind: "task_completed",
        label: `Tarea completada: ${row.title}`,
        description: null,
        meta: { task_id: row.id, task_type: row.task_type },
        actorUserId: row.assigned_user_id,
        opportunityId: row.opportunity_id,
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
    row.activity_type === "manual_note" ? "manual_note" : "other_activity";
  return {
    id: `activities:${row.id}`,
    source: "activities",
    occurredAt: row.created_at,
    kind,
    label: row.description,
    description: null,
    meta: {
      activity_type: row.activity_type,
      ...(typeof row.payload === "object" && row.payload !== null
        ? (row.payload as Record<string, unknown>)
        : {}),
    },
    actorUserId: row.triggered_by_user_id,
    opportunityId: row.opportunity_id,
  };
}

// ------------------------------------------------------------
// audit_log (whitelisted)
// ------------------------------------------------------------

async function fetchAuditEvents(
  q: TimelineQuery,
  limit: number,
): Promise<TimelineEvent[]> {
  const { supabase, organizationId } = getTenantScopedClient();
  let query = supabase
    .from("audit_log")
    .select("*")
    .eq("organization_id", organizationId);

  if ("opportunityId" in q.scope) {
    query = query.eq("entity_type", "opportunity").eq("entity_id", q.scope.opportunityId);
  } else {
    query = query.eq("entity_type", "contact").eq("entity_id", q.scope.contactId);
  }

  // Sin filtro de event_type a nivel SQL — PostgREST no soporta
  // bien arrays grandes con `.in()` para texto, y la whitelist es
  // pequeña, así que filtramos en memoria. Para volúmenes mayores
  // (M10+), conviene índice + filter SQL específico.
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit * 3); // sobre-pedimos: muchos audits caerán en el descarte
  if (error) throw error;

  const rows = (data ?? []) as AuditLogRow[];
  const events: TimelineEvent[] = [];
  for (const row of rows) {
    if (!AUDIT_EVENT_WHITELIST.has(row.event_type)) continue;
    events.push(auditToEvent(row));
    if (events.length >= limit) break;
  }
  return events;
}

function auditToEvent(row: AuditLogRow): TimelineEvent {
  const payload = (typeof row.payload === "object" && row.payload !== null
    ? (row.payload as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const kind = mapAuditKind(row.event_type);
  const label = mapAuditLabel(row.event_type, payload);
  // Para reasignaciones la entidad ancla puede ser contact u opportunity
  // — usamos el entity_id como opportunityId solo si entity_type lo es.
  const opportunityId =
    row.entity_type === "opportunity" ? (row.entity_id as UUID | null) : null;

  return {
    id: `audit:${row.id}`,
    source: "audit",
    occurredAt: row.created_at,
    kind,
    label,
    description: null,
    meta: { event_type: row.event_type, ...payload },
    actorUserId: row.actor_user_id,
    opportunityId,
  };
}

function mapAuditKind(eventType: string): TimelineKind {
  switch (eventType) {
    case "contact_reassigned":
    case "opportunity_reassigned":
      return "reassignment";
    case "contact_edited_manually":
      return "contact_edited";
    case "shopify_customer_created_outbound":
      return "contact_created_in_shopify";
    case "shopify_customer_matched_existing_on_create":
      return "contact_matched_in_shopify";
    case "whaapy_contact_created_outbound":
    case "whaapy_contact_matched_existing_on_create":
      return "contact_created_in_whaapy";
    case "c2_opportunity_auto_created":
      return "opportunity_auto_created";
    default:
      return "other_audit";
  }
}

function mapAuditLabel(
  eventType: string,
  payload: Record<string, unknown>,
): string {
  switch (eventType) {
    case "contact_reassigned":
      return "Contacto reasignado";
    case "opportunity_reassigned":
      return "Oportunidad reasignada";
    case "contact_edited_manually": {
      const fields = payload.fields as unknown;
      if (Array.isArray(fields) && fields.length > 0) {
        return `Contacto editado (${fields.join(", ")})`;
      }
      return "Contacto editado";
    }
    case "shopify_customer_created_outbound":
      return "Contacto creado en Shopify";
    case "shopify_customer_matched_existing_on_create":
      return "Contacto vinculado a customer existente en Shopify";
    case "whaapy_contact_created_outbound":
      return "Contacto creado en Whaapy";
    case "whaapy_contact_matched_existing_on_create":
      return "Contacto vinculado a contacto existente en Whaapy";
    case "c2_opportunity_auto_created": {
      const trigger = payload.trigger as string | undefined;
      if (trigger === "new_contact_in_whaapy") {
        return "Oportunidad creada automáticamente (Lead nuevo en Whaapy)";
      }
      if (trigger === "reactivity_after_n_days") {
        return "Oportunidad creada automáticamente (re-actividad del contacto)";
      }
      return "Oportunidad creada automáticamente";
    }
    default:
      return eventType;
  }
}

export type { Json };
