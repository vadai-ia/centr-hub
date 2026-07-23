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
 * Tag aplicado al customer de Shopify cuando el contacto se archiva por
 * borrado en Whaapy (Fix A — propagación del archivado). NO se borra el
 * customer (Shopify bloquea borrar customers con órdenes + doctrina
 * "nunca borrado físico"): se etiqueta de forma reversible y no
 * destructiva. La escritura saliente lleva marca R11 (markOutboundWrite),
 * así el `customers/update` resultante se descarta como eco propio.
 */
export const WHAAPY_DELETED_SHOPIFY_TAG = "Eliminado en Whaapy" as const;

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

/**
 * Auto-ocultar cerradas (anti-ruido — Fix de pipeline).
 *
 * `DEFAULT_HIDE_CLOSED_AFTER_DAYS` — umbral global por defecto: una opp
 *   en etapa Ganada/Perdida se oculta del kanban tras este número de
 *   días desde su cierre (won_at/lost_at). Editable por el admin desde
 *   el propio pipeline; vive en `organizations.config.pipeline.
 *   hide_closed_after_days`. Es SOLO visualización del kanban — NO
 *   afecta KPIs, no borra, no cambia etapa, no cancela.
 *
 * `HIDE_CLOSED_DAYS_MIN/MAX` — límites de saneamiento del valor
 *   configurable (0 = ocultar apenas se cierra; tope alto evita errores
 *   de captura). El admin puede poner 0 para ocultar de inmediato.
 */
export const DEFAULT_HIDE_CLOSED_AFTER_DAYS = 7 as const;
export const HIDE_CLOSED_DAYS_MIN = 0 as const;
export const HIDE_CLOSED_DAYS_MAX = 365 as const;

/**
 * Piso de visibilidad del pipeline (cutoff de arranque operativo). El kanban
 * muestra SOLO oportunidades con `effective_created_at >= este día` O que
 * sigan trabajándose (`last_modified_at >= este día` por una fuente NO
 * automática). Vive en `organizations.config.pipeline.min_effective_date`
 * (formato 'YYYY-MM-DD', interpretado como inicio de día en CDMX); este
 * default aplica cuando la org no lo sobreescribe. Es SOLO visualización del
 * kanban — dashboard/búsqueda/KPIs intactos; nada se borra ni se archiva.
 */
export const DEFAULT_PIPELINE_MIN_DATE = "2026-06-01" as const;

/**
 * Fuentes de `last_modified_at` que NO cuentan como "sigue trabajándose"
 * para el piso de visibilidad: son escrituras internas sintéticas (cron de
 * transiciones de Post-venta, trigger F1→F2, seeds/backfill). Un toque de
 * estas fuentes sobre una opp vieja NO la resucita en el kanban. Las fuentes
 * humanas ('platform') y externas reales ('shopify'/'whaapy') sí la conservan.
 */
export const PIPELINE_FLOOR_AUTOMATED_SOURCES = [
  "automation",
  "trigger_f1_f2",
  "system",
] as const;

/**
 * `CLOSED_LIST_RETENTION_DAYS` (M4v2) — segunda barrera de visualización
 * por ENCIMA del auto-ocultar. Una oportunidad cerrada (Ganada/Perdida/
 * Caso cerrado) deja de listarse en "Ver cerradas" cuando cumple este
 * número de días ARCHIVADA (contado desde su `won_at`/`lost_at`); los
 * casos resueltos de Post-venta usan el mismo umbral sobre `resolved_at`.
 * Ventana móvil POR oportunidad (no corte de mes calendario), en TZ CDMX.
 * Es SOLO visualización — NO borra de la BD; histórico/reportes/métricas
 * quedan intactos. Fijo (no configurable) por decisión de M4v2.
 *
 * Modelo de dos umbrales: 0–N días → en el activo; N–30 días → solo en
 * "Ver cerradas"; >30 días → fuera de ambas vistas, vivo en la BD.
 */
export const CLOSED_LIST_RETENTION_DAYS = 30 as const;

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

/**
 * Dashboard descriptivo (M8.2).
 *
 * `DASHBOARD_STAGE_WINRATE_MIN_SAMPLE` — umbral FIJO de muestra para
 *   el KPI "Win rate por etapa": si una etapa tiene menos de N opps
 *   en el periodo, se muestra "Muestra pequeña" en vez del %. Fijo en
 *   V1, no configurable (las metas/umbrales configurables son V2).
 *   Es deliberadamente independiente de `DEFAULT_THRESHOLDS.
 *   win_rate_min_sample` (config V2) para no acoplar el dashboard
 *   descriptivo a la maquinaria de cumplimiento futura.
 *
 * `DASHBOARD_REPURCHASE_WINDOW_MONTHS` — ventana del KPI "Tasa de
 *   recompra" (clientes con >1 order en los últimos N meses).
 *
 * `DASHBOARD_EXPORT_MAX_ROWS` — tope defensivo de filas por tabla en
 *   los exports (drilldown por vendedor, pérdidas por motivo). Los
 *   KPIs son agregados, no volcados de filas, así que este límite no
 *   debería alcanzarse en una org del MVP; actúa como circuit breaker.
 */
export const DASHBOARD_STAGE_WINRATE_MIN_SAMPLE = 10 as const;
export const DASHBOARD_REPURCHASE_WINDOW_MONTHS = 12 as const;
export const DASHBOARD_EXPORT_MAX_ROWS = 5000 as const;
