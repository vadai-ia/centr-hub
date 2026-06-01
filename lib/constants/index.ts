/**
 * Constantes centralizadas del proyecto (Sección 3.2).
 * ENUMs, defaults, umbrales y configuración base viven aquí —
 * no esparcidos por el código.
 */

export const TIMEZONE = "America/Mexico_City" as const;

export const FUNNELS = ["venta", "post_venta"] as const;
export type Funnel = (typeof FUNNELS)[number];

export const ROLES = ["superadmin", "admin", "vendedor"] as const;
export type Role = (typeof ROLES)[number];

export const NOTIFICATION_STATUSES = [
  "pending",
  "completed",
  "snoozed",
  "dismissed",
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const TASK_STATUSES = ["pending", "completed", "snoozed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const NOTIFICATION_ORIGINS = ["rule", "manual", "system"] as const;
export type NotificationOrigin = (typeof NOTIFICATION_ORIGINS)[number];

export const RULE_EXECUTION_STATUSES = [
  "success",
  "failed",
  "skipped",
] as const;
export type RuleExecutionStatus = (typeof RULE_EXECUTION_STATUSES)[number];

export const STAGE_HISTORY_CONTEXTS = [
  "manual",
  "webhook",
  "automation",
  "trigger_f1_f2",
  "seed",
  "backfill",
] as const;
export type StageHistoryContext = (typeof STAGE_HISTORY_CONTEXTS)[number];

export const RULE_TRIGGER_TYPES = [
  "stage_aging",
  "no_activity",
  "created",
  "stage_changed",
  "won",
  "lost",
  "contact.created",
  "contact.no_activity",
] as const;
export type RuleTriggerType = (typeof RULE_TRIGGER_TYPES)[number];

export const TAG_CLASSIFICATIONS = ["vendor", "informational"] as const;
export type TagClassification = (typeof TAG_CLASSIFICATIONS)[number];

export const DEFAULT_CURRENCY = "MXN" as const;

/**
 * Default thresholds for new orgs (mirrored in
 * `organizations.config` default at the SQL layer).
 */
export const DEFAULT_THRESHOLDS = {
  coverage_green_pct: 300,
  coverage_yellow_pct: 200,
  compliance_green_pct: 100,
  compliance_yellow_pct: 90,
  win_rate_min_sample: 10,
} as const;

/** Postgres session setting name used by the tenant wrapper. */
export const PG_TENANT_SETTING = "app.current_organization_id" as const;

/** Marker for outbound writes — used by R11 sync-loop defense (option A). */
export const PLATFORM_ORIGIN_MARKER = "centrhub" as const;

/**
 * Pipeline kanban (M5).
 *
 * `PIPELINE_PAGE_SIZE`     — número de cards traídas por columna en
 *                            cada page del scroll server-side. 50
 *                            cubre la mayoría de etapas sin saturar
 *                            la primera transferencia.
 *
 * `PIPELINE_VIRTUALIZATION_THRESHOLD` — a partir de cuántas cards
 *                            por columna se activa virtualización con
 *                            `@tanstack/react-virtual`. 50 = el page
 *                            size: si una columna trae al menos un
 *                            page completo, asumimos que puede crecer.
 *
 * `PIPELINE_REALTIME_DEBOUNCE_MS` — debounce para coalescer múltiples
 *                            updates del mismo opportunity en cluster
 *                            corto (ej. webhook + lww + last_modified).
 *
 * `PIPELINE_POLLING_FALLBACK_MS` — periodo del polling fallback que
 *                            se activa cuando Supabase Realtime emite
 *                            'CHANNEL_ERROR' o queda 'TIMED_OUT' tras
 *                            varios intentos. Más alto que el de
 *                            realtime puro porque solo cubre el peor
 *                            caso operativo.
 *
 * `PIPELINE_REALTIME_RECONNECT_TIMEOUT_MS` — periodo tras el cual,
 *                            si la reconexión no se ha establecido,
 *                            se muestra al usuario el mensaje sugiriendo
 *                            reload manual.
 */
export const PIPELINE_PAGE_SIZE = 50 as const;
export const PIPELINE_VIRTUALIZATION_THRESHOLD = 50 as const;
export const PIPELINE_REALTIME_DEBOUNCE_MS = 150 as const;
export const PIPELINE_POLLING_FALLBACK_MS = 30_000 as const;
export const PIPELINE_REALTIME_RECONNECT_TIMEOUT_MS = 30_000 as const;

/** Cookie de preferencia del funnel activo del usuario en M5. */
export const PIPELINE_FUNNEL_COOKIE = "centr_pipeline_funnel" as const;
/** Cookie de preferencia del filtro admin "Sin asignar" en M5. */
export const PIPELINE_UNASSIGNED_COOKIE = "centr_pipeline_unassigned" as const;

/**
 * Listado de Contactos (M6).
 *
 * `CONTACTS_PAGE_SIZE` — número de contactos por page del listado
 *                       paginado. 50 = ~3 viewports en desktop sin
 *                       saturar la primera transferencia.
 * `CONTACT_SEARCH_DEBOUNCE_MS` — debounce del input de búsqueda. 300ms
 *                       cubre tipeo humano normal sin saturar la BD.
 * `TIMELINE_DEFAULT_LIMIT` — eventos por fuente al construir el
 *                       timeline unificado (contacto y oportunidad).
 *                       Cada fuente trae N; el merger ordena por ts
 *                       y deja los más recientes. Default conservador.
 */
export const CONTACTS_PAGE_SIZE = 50 as const;
export const CONTACT_SEARCH_DEBOUNCE_MS = 300 as const;
export const TIMELINE_DEFAULT_LIMIT = 50 as const;
