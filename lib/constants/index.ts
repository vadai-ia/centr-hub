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
