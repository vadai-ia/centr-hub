/**
 * Tipos de la base de datos (M1).
 *
 * Por ahora se mantienen a mano — espejan exactamente el schema
 * de las migraciones 0001..0010. Cuando el operador habilite el
 * Supabase CLI en un milestone posterior, este archivo se reemplaza
 * por la salida de `supabase gen types typescript`. Los tipos custom
 * (`lib/types/domain.ts`) se construyen ENCIMA de estos.
 */

export type UUID = string;
export type ISODateString = string;
export type Numeric = string; // pg numeric viene como string en supabase-js
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json }
  | Json[];

// `Funnel` se define UNA vez en `lib/constants` (runtime `FUNNELS` + tipo
// derivado). Se importa (binding local, usado por los Row de abajo) y se
// re-exporta para que los muchos `import { Funnel } from "@/lib/types/database"`
// sigan funcionando sin duplicar el dominio {'outbound','venta','post_venta'}
// (Fase 1 de Outbound).
import type { Funnel } from "@/lib/constants";
export type { Funnel };
/**
 * Roles de SISTEMA (protegidos, siembra 0039). NO es el universo cerrado
 * de roles: desde el constructor de roles se crean roles custom cuya `key`
 * es un string arbitrario. Por eso `MembershipRow.role` es `string`, no
 * `Role` — este alias solo tipa las comparaciones contra roles de sistema.
 */
export type Role = "superadmin" | "admin" | "vendedor";
export type DataScope = "own" | "all";
export type TaskStatus = "pending" | "completed" | "snoozed";
export type NotificationStatus =
  | "pending"
  | "completed"
  | "snoozed"
  | "dismissed";
export type NotificationOrigin = "rule" | "manual" | "system";
export type RuleExecutionStatus = "success" | "failed" | "skipped";
export type StageHistoryContext =
  | "manual"
  | "webhook"
  | "automation"
  | "trigger_f1_f2"
  | "seed"
  | "backfill";
export type RuleTriggerType =
  | "stage_aging"
  | "no_activity"
  | "created"
  | "stage_changed"
  | "won"
  | "lost"
  | "contact.created"
  | "contact.no_activity";
export type TagClassification = "vendor" | "informational";

export interface OrganizationRow {
  id: UUID;
  name: string;
  slug: string;
  shopify_store_url: string | null;
  shopify_store_domain: string | null;
  whaapy_business_id: string | null;
  whaapy_postventa_business_id: string | null;
  branding: Json;
  config: Json;
  vault_keys: Json;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface UserProfileRow {
  id: UUID;
  full_name: string;
  phone: string | null;
  avatar_url: string | null;
  color: string;
  is_system_user: boolean;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface MembershipRow {
  id: UUID;
  user_id: UUID;
  organization_id: UUID;
  // Dinámico desde 0039: es la `key` de una fila `roles` de la org (FK
  // compuesto memberships(org, role) → roles(org, key)). Puede ser un rol
  // de sistema ('admin'|'vendedor'|'superadmin') o uno custom ('sdr', ...).
  role: string;
  is_active: boolean;
  whaapy_agent_id: string | null;
  /** Round-robin de leads por webhook (0045): true = en la rotación. Solo
   *  aplica a vendedores; default true. Ver lib/services/lead-advisor-assignment. */
  in_lead_rotation: boolean;
  created_at: ISODateString;
  updated_at: ISODateString;
}

/**
 * Rol configurable de una organización (0039). Modelo de dos ejes:
 * `allowed_tabs` (qué pestañas ve) + `data_scope` (qué datos alcanza).
 * `is_system` protege admin/vendedor/superadmin de borrado y de quedar
 * sin pestañas. La proyección de capacidades vive en lib/auth/capabilities.
 */
export interface RoleRow {
  id: UUID;
  organization_id: UUID;
  key: string;
  label: string;
  data_scope: DataScope;
  allowed_tabs: string[];
  is_system: boolean;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface ContactRow {
  id: UUID;
  organization_id: UUID;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  address: Json | null;
  internal_note: string | null;
  shopify_tags: string[];
  shopify_state: string | null;
  assigned_advisor_id: UUID | null;
  shopify_customer_id: string | null;
  whaapy_contact_id: string | null;
  field_metadata: Json;
  last_modified_at: ISODateString;
  last_modified_source: string;
  missing_phone: boolean;
  deleted_in_shopify: boolean;
  deleted_in_whaapy: boolean;
  anonymized_at: ISODateString | null;
  // Migración 0013 (v5.1): última actividad observada en Whaapy.
  // Usado por R12 (b) y la pestaña Contactos para "sin actividad X días".
  last_whaapy_activity_at: ISODateString | null;
  // Marca outbound (0040) — FUENTE DE VERDAD. true = contacto trabajado por
  // el SDR en el pipeline Outbound. Permanente (solo admin des-marca, con
  // audit). Se denormaliza a opportunities/orders para métricas.
  is_outbound: boolean;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface PipelineStageRow {
  id: UUID;
  organization_id: UUID;
  funnel: Funnel;
  name: string;
  position: number;
  color: string;
  default_probability: Numeric | null;
  is_initial: boolean;
  is_won: boolean;
  is_lost: boolean;
  requires_loss_reason: boolean;
  is_active: boolean;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface LossReasonRow {
  id: UUID;
  organization_id: UUID;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface OpportunityRow {
  id: UUID;
  organization_id: UUID;
  funnel: Funnel;
  stage_id: UUID;
  contact_id: UUID;
  assigned_advisor_id: UUID | null;
  parent_opportunity_id: UUID | null;
  shopify_draft_order_id: string | null;
  shopify_order_id: string | null;
  display_reference: string | null;
  actual_amount: Numeric | null;
  estimated_amount: Numeric | null;
  currency: string;
  probability_override: Numeric | null;
  weighted_amount: Numeric | null;
  loss_reason_id: UUID | null;
  invoice_url: string | null;
  note: string | null;
  shipping_address: Json | null;
  last_modified_at: ISODateString;
  last_modified_source: string;
  created_at: ISODateString;
  updated_at: ISODateString;
  won_at: ISODateString | null;
  // Momento en que entró a una etapa Perdida (espejo de won_at). Lo
  // setea pipeline-move al mover a etapa is_lost; NULL si nunca se
  // perdió. Usado por el auto-ocultar del kanban (0026). No afecta KPIs.
  lost_at: ISODateString | null;
  invoice_sent_at: ISODateString | null;
  // Cancelación administrativa (0014). cancelled_at IS NULL → activa.
  // cancellation_source: 'shopify_draft_deleted' | 'admin_manual' |
  //                      'system_other' (string libre, extensible).
  cancelled_at: ISODateString | null;
  cancellation_source: string | null;
  cancellation_note: string | null;
  // Fecha real de creación de la Cotización en Shopify (created_at del
  // Draft Order). NULL para opps nacidas en plataforma sin draft (lead
  // R12, manual). Distinto de created_at (entrada a la BD). Migración 0025.
  shopify_created_at: ISODateString | null;
  // COALESCE(shopify_created_at, created_at) — eje temporal real para el
  // dashboard. Columna GENERADA stored: NO escribible (excluida de
  // Insert/Update). Migración 0025.
  effective_created_at: ISODateString;
  // Cierre de "Caso problemático" de Post-venta (0032). resolved_at IS
  // NULL → caso abierto (visible en el pipeline); IS NOT NULL → resuelto
  // y archivado (fuera de las vistas activas, localizable en "Casos
  // resueltos"). La etapa NO cambia al resolver (se preserva). Solo
  // semántica de Post-venta — opps de Venta nunca se resuelven.
  resolved_at: ISODateString | null;
  resolved_by_user_id: UUID | null;
  resolution_note: string | null;
  // Reapertura a "Caso problemático" (0035, M4v2). NULL → la opp llegó a
  // su etapa por el flujo normal; IS NOT NULL → fue reabierta manualmente
  // desde el botón "+". Flag de procedencia (badge "Reabierto"), ortogonal
  // al estado de archivado. La reapertura limpia cancelled/won/lost/resolved.
  reopened_at: ISODateString | null;
  // Atribución de origen del lead (0038). Se sella al crear la opp "Lead
  // nuevo" desde el camino canónico de creación de leads: "manual" |
  // "webhook". NULL = nacida por otra vía (draft Shopify, R12, reapertura).
  lead_source: string | null;
  // Fuente de webhook específica que originó el lead (0038, FK a
  // inbound_webhook_sources). NULL para leads manuales o de otra vía.
  inbound_webhook_source_id: UUID | null;
  // Marca outbound denormalizada (0040) desde el contacto. Se estampa al
  // crear la opp (birth-stamping) y al convertir el contacto (solo opps no
  // terminales). El dashboard la usa para el split outbound/inbound.
  is_outbound: boolean;
  // Conflicto de asesor por tag de Shopify (0043): un tag (draft/orden) intentó
  // asignar ESTE asesor pero se conservó el de la entrega Outbound (handoff
  // gana). NULL = sin conflicto. La reasignación manual lo limpia. Informativo.
  overridden_tag_advisor_id: UUID | null;
}

export interface OpportunityLineItemRow {
  id: UUID;
  organization_id: UUID;
  opportunity_id: UUID;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  title: string;
  sku: string | null;
  quantity: number;
  variant_title: string | null;
  original_unit_price: Numeric;
  discount_amount: Numeric;
  final_price: Numeric;
  weight_grams: Numeric | null;
  taxable: boolean;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface OpportunityStageHistoryRow {
  id: UUID;
  organization_id: UUID;
  opportunity_id: UUID;
  from_stage_id: UUID | null;
  to_stage_id: UUID;
  changed_by_user_id: UUID | null;
  context: StageHistoryContext;
  changed_at: ISODateString;
  // Fecha real del evento de Shopify detrás de la entrada de etapa (DO
  // created_at para Cotización vía webhook; fecha del pedido para Ganada
  // vía trigger). NULL para entradas de origen plataforma (manual).
  // Migración 0025.
  shopify_event_at: ISODateString | null;
  // COALESCE(shopify_event_at, changed_at) — eje temporal real para el
  // dashboard. Columna GENERADA stored: NO escribible. Migración 0025.
  effective_event_at: ISODateString;
}

export interface OrderRow {
  id: UUID;
  organization_id: UUID;
  contact_id: UUID;
  assigned_advisor_id: UUID | null;
  opportunity_id: UUID | null;
  shopify_order_id: string;
  shopify_name: string | null;
  financial_status: string;
  fulfillment_status: string | null;
  total_amount: Numeric;
  subtotal: Numeric;
  taxes_amount: Numeric;
  shipping_amount: Numeric;
  discount_amount: Numeric;
  currency: string;
  cancellation_reason: string | null;
  source: string | null;
  shopify_tags: string[];
  last_modified_at: ISODateString;
  last_modified_source: string;
  created_at: ISODateString;
  updated_at: ISODateString;
  paid_at: ISODateString | null;
  cancelled_at: ISODateString | null;
  // Fecha real de creación del pedido en Shopify (created_at del objeto
  // Order de Shopify). Distinto de `created_at`, que es cuándo el
  // registro entró a la BD local. NULL en filas pre-fix 0024 hasta que
  // el correctivo las popule. El dashboard cuenta pedidos por esta
  // columna, no por `created_at` (migración 0024).
  shopify_created_at: ISODateString | null;
  // Estado de ENTREGA normalizado del pedido (derivado de los fulfillments
  // de Shopify): 'delivered' = entregado al cliente; 'in_progress' =
  // seguimiento añadido / en tránsito, aún no entregado; NULL = sin señal de
  // entrega. Distinto de `fulfillment_status` (preparación). El motor de
  // Post-venta mueve Envío en curso / Entregado por esta columna
  // (migración 0036). NULL en filas pre-fix hasta el correctivo
  // backfill-order-delivery-status o el cron.
  delivery_status: string | null;
  // Marca outbound denormalizada (0040) para el split de revenue del
  // dashboard. El estampado se cablea en la Fase 4.
  is_outbound: boolean;
}

export interface OrderLineItemRow {
  id: UUID;
  organization_id: UUID;
  order_id: UUID;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  title: string;
  sku: string | null;
  quantity: number;
  variant_title: string | null;
  original_unit_price: Numeric;
  discount_amount: Numeric;
  final_price: Numeric;
  weight_grams: Numeric | null;
  taxable: boolean;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface AutomationRuleRow {
  id: UUID;
  organization_id: UUID;
  funnel: Funnel;
  name: string;
  description: string | null;
  is_active: boolean;
  is_template: boolean;
  trigger_type: RuleTriggerType;
  trigger_config: Json;
  conditions: Json;
  actions: Json;
  schema_version: string;
  created_by_user_id: UUID | null;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface RuleExecutionRow {
  id: UUID;
  organization_id: UUID;
  rule_id: UUID;
  opportunity_id: UUID | null;
  contact_id: UUID | null;
  status: RuleExecutionStatus;
  result: Json;
  executed_at: ISODateString;
}

export interface ActivityRow {
  id: UUID;
  organization_id: UUID;
  contact_id: UUID | null;
  opportunity_id: UUID | null;
  activity_type: string;
  description: string;
  payload: Json;
  triggered_by_user_id: UUID | null;
  created_at: ISODateString;
}

export interface TaskRow {
  id: UUID;
  organization_id: UUID;
  contact_id: UUID | null;
  opportunity_id: UUID | null;
  assigned_user_id: UUID;
  task_type: string;
  title: string;
  description: string | null;
  due_at: ISODateString | null;
  status: TaskStatus;
  snoozed_until: ISODateString | null;
  // Procedencia: regla de automatización que generó esta tarea (M1v2,
  // migración 0029). NULL para tareas manuales. Habilita idempotencia R4
  // (no duplicar mientras haya una abierta de la misma regla) y el motivo
  // "generada por regla" en Mi Día.
  created_by_rule_id: UUID | null;
  created_at: ISODateString;
  updated_at: ISODateString;
  completed_at: ISODateString | null;
}

export interface NotificationRow {
  id: UUID;
  organization_id: UUID;
  user_id: UUID;
  notification_type: string;
  origin: NotificationOrigin;
  origin_reference: Json;
  opportunity_id: UUID | null;
  contact_id: UUID | null;
  title: string;
  message: string;
  amount_at_stake: Numeric | null;
  due_at: ISODateString | null;
  status: NotificationStatus;
  snoozed_until: ISODateString | null;
  schema_version: string;
  created_at: ISODateString;
  updated_at: ISODateString;
  completed_at: ISODateString | null;
}

export interface AuditLogRow {
  id: UUID;
  organization_id: UUID;
  actor_user_id: UUID | null;
  event_type: string;
  entity_type: string | null;
  entity_id: UUID | null;
  payload: Json;
  ip_address: string | null;
  created_at: ISODateString;
}

/** Métrica de una meta (M2v2). Espejo de `GOAL_METRICS` en lib/metas/schema. */
export type GoalMetricDb = "quotes" | "won" | "amount";

/**
 * Meta mensual recurrente (M2v2 — reshape 0031). Una fila por (org,
 * vendedor-o-equipo, métrica). `advisor_membership_id` NULL = meta general
 * de equipo. El periodo es siempre el mes en curso (CDMX).
 */
export interface GoalRow {
  id: UUID;
  organization_id: UUID;
  advisor_membership_id: UUID | null;
  metric: GoalMetricDb;
  target_value: Numeric;
  is_active: boolean;
  created_by_user_id: UUID | null;
  created_at: ISODateString;
  updated_at: ISODateString;
}

/**
 * Snapshot histórico mensual del cumplimiento de una meta (M2v2 — 0031).
 * Append-only (sin updated_at): lo escribe el cron mensual de Inngest.
 * Self-contained — guarda métrica/target/logrado/pct por si la meta cambia
 * o se borra después.
 */
export interface GoalResultRow {
  id: UUID;
  organization_id: UUID;
  goal_id: UUID | null;
  advisor_membership_id: UUID | null;
  metric: GoalMetricDb;
  period_month: string; // date — primer día del mes (CDMX), yyyy-MM-dd
  target_value: Numeric;
  achieved_value: Numeric;
  pct: Numeric;
  created_at: ISODateString;
}

export interface TagMappingRow {
  id: UUID;
  organization_id: UUID;
  normalized_tag: string;
  original_tag: string;
  classification: TagClassification;
  mapped_membership_id: UUID | null;
  created_by_user_id: UUID | null;
  created_at: ISODateString;
  updated_at: ISODateString;
}

/**
 * Forma minimal de Database aceptada por @supabase/supabase-js.
 * Solo se exponen Row + Insert + Update para que las queries
 * tipadas no requieran el generador. Para campos auto-generados
 * (id, created_at, updated_at) usamos `?` en Insert.
 */
export interface InboundWebhookSourceRow {
  id: UUID;
  organization_id: UUID;
  name: string;
  slug: string;
  token_hash: string;
  token_last4: string;
  is_active: boolean;
  created_by_user_id: UUID | null;
  last_used_at: ISODateString | null;
  rotated_at: ISODateString | null;
  created_at: ISODateString;
  updated_at: ISODateString;
}

/**
 * Conexión externa administrable (0046). Metadata NO SECRETA — las
 * credenciales siguen en `organizations.vault_keys` (solo service_role).
 * De cada credencial aquí vive únicamente su `last4` para la UI.
 */
export type IntegrationProvider = "shopify" | "whaapy_venta" | "whaapy_postventa";
export type IntegrationStatus = "not_configured" | "connected" | "disconnected";

export interface IntegrationConnectionRow {
  id: UUID;
  organization_id: UUID;
  provider: IntegrationProvider;
  status: IntegrationStatus;
  /** { client_secret: "ab12", api_key: "...", ... } — NUNCA el valor completo. */
  credential_last4: Json;
  callback_url: string | null;
  webhook_registered_at: ISODateString | null;
  last_test_at: ISODateString | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  connected_at: ISODateString | null;
  disconnected_at: ISODateString | null;
  /** Sube con cada reemplazo del sistema externo. Sufija los ids desenlazados. */
  generation: number;
  updated_by_user_id: UUID | null;
  created_at: ISODateString;
  updated_at: ISODateString;
}

type Insertable<R extends { id: UUID; created_at: ISODateString; updated_at: ISODateString }> =
  Omit<R, "id" | "created_at" | "updated_at"> &
    Partial<Pick<R, "id" | "created_at" | "updated_at">>;

type Updatable<R> = Partial<R>;

export interface Database {
  public: {
    Tables: {
      organizations: { Row: OrganizationRow; Insert: Insertable<OrganizationRow>; Update: Updatable<OrganizationRow> };
      user_profiles: { Row: UserProfileRow; Insert: Insertable<UserProfileRow>; Update: Updatable<UserProfileRow> };
      // in_lead_rotation tiene DEFAULT true en SQL (0045) → opcional en Insert
      // para no romper los callers de createMembership (ERRORES.md "Insertable").
      memberships: { Row: MembershipRow; Insert: Omit<Insertable<MembershipRow>, "in_lead_rotation"> & Partial<Pick<MembershipRow, "in_lead_rotation">>; Update: Updatable<MembershipRow> };
      roles: { Row: RoleRow; Insert: Insertable<RoleRow>; Update: Updatable<RoleRow> };
      contacts: {
        Row: ContactRow;
        // is_outbound (0040) nullable-por-default en BD (NOT NULL DEFAULT
        // false): opcional en Insert para no romper los callers V1 (un
        // contacto nace inbound salvo que el path outbound lo setee).
        Insert: Omit<Insertable<ContactRow>, "is_outbound"> &
          Partial<Pick<ContactRow, "is_outbound">>;
        Update: Updatable<ContactRow>;
      };
      pipeline_stages: { Row: PipelineStageRow; Insert: Insertable<PipelineStageRow>; Update: Updatable<PipelineStageRow> };
      loss_reasons: { Row: LossReasonRow; Insert: Insertable<LossReasonRow>; Update: Updatable<LossReasonRow> };
      opportunities: {
        Row: OpportunityRow;
        // effective_created_at es GENERADA → no escribible. shopify_created_at
        // queda REQUERIDA en Insert (como orders en 0024): obliga a cada
        // path de inserción a decidir conscientemente la fecha de Shopify
        // (draft → normalized.createdAt; lead R12/manual → null).
        // resolved_* (0032) son nullable con default NULL: opcionales en
        // Insert para no romper los callers V1 (createOpportunity/trigger);
        // solo el flujo de cierre de caso (M3v2) las escribe.
        // lead_source / inbound_webhook_source_id (0038) idem: nullable con
        // default NULL, solo el camino canónico de creación de leads las setea.
        // is_outbound (0040): NOT NULL DEFAULT false → opcional en Insert
        // (el birth-stamping lo pasa desde el contacto; los callers que lo
        // omiten heredan false = inbound).
        Insert: Omit<
          Insertable<OpportunityRow>,
          | "effective_created_at"
          | "resolved_at"
          | "resolved_by_user_id"
          | "resolution_note"
          | "reopened_at"
          | "lead_source"
          | "inbound_webhook_source_id"
          | "is_outbound"
          | "overridden_tag_advisor_id"
        > &
          Partial<
            Pick<
              OpportunityRow,
              | "resolved_at"
              | "resolved_by_user_id"
              | "resolution_note"
              | "reopened_at"
              | "lead_source"
              | "inbound_webhook_source_id"
              | "is_outbound"
              | "overridden_tag_advisor_id"
            >
          >;
        Update: Omit<Updatable<OpportunityRow>, "effective_created_at">;
      };
      opportunity_line_items: { Row: OpportunityLineItemRow; Insert: Insertable<OpportunityLineItemRow>; Update: Updatable<OpportunityLineItemRow> };
      opportunity_stage_history: {
        Row: OpportunityStageHistoryRow;
        // effective_event_at es GENERADA → no escribible. shopify_event_at
        // es opcional en Insert (solo contextos Shopify lo pasan).
        Insert: Omit<OpportunityStageHistoryRow, "id" | "changed_at" | "shopify_event_at" | "effective_event_at"> &
          Partial<Pick<OpportunityStageHistoryRow, "id" | "changed_at" | "shopify_event_at">>;
        Update: Omit<Updatable<OpportunityStageHistoryRow>, "effective_event_at">;
      };
      orders: {
        Row: OrderRow;
        // is_outbound (0040): NOT NULL DEFAULT false → opcional en Insert
        // (el estampado se cablea en la Fase 4; hasta entonces default false).
        Insert: Omit<Insertable<OrderRow>, "is_outbound"> &
          Partial<Pick<OrderRow, "is_outbound">>;
        Update: Updatable<OrderRow>;
      };
      order_line_items: { Row: OrderLineItemRow; Insert: Insertable<OrderLineItemRow>; Update: Updatable<OrderLineItemRow> };
      automation_rules: { Row: AutomationRuleRow; Insert: Insertable<AutomationRuleRow>; Update: Updatable<AutomationRuleRow> };
      rule_executions: {
        Row: RuleExecutionRow;
        Insert: Omit<RuleExecutionRow, "id" | "executed_at"> & Partial<Pick<RuleExecutionRow, "id" | "executed_at">>;
        Update: Updatable<RuleExecutionRow>;
      };
      activities: {
        Row: ActivityRow;
        Insert: Omit<ActivityRow, "id" | "created_at"> & Partial<Pick<ActivityRow, "id" | "created_at">>;
        Update: Updatable<ActivityRow>;
      };
      tasks: {
        Row: TaskRow;
        // created_by_rule_id es nullable y opcional en Insert: las tareas
        // manuales (la mayoría de los callers V1) la omiten; solo el motor
        // de reglas la setea. Sin este Omit quedaría REQUERIDA en cada
        // insert (lección Insertable + lost_at, ERRORES.md).
        Insert: Omit<Insertable<TaskRow>, "created_by_rule_id"> &
          Partial<Pick<TaskRow, "created_by_rule_id">>;
        Update: Updatable<TaskRow>;
      };
      notifications: { Row: NotificationRow; Insert: Insertable<NotificationRow>; Update: Updatable<NotificationRow> };
      audit_log: {
        Row: AuditLogRow;
        Insert: Omit<AuditLogRow, "id" | "created_at"> & Partial<Pick<AuditLogRow, "id" | "created_at">>;
        Update: Updatable<AuditLogRow>;
      };
      goals: { Row: GoalRow; Insert: Insertable<GoalRow>; Update: Updatable<GoalRow> };
      goal_results: {
        Row: GoalResultRow;
        // Append-only: sin updated_at. id/created_at auto-generados.
        Insert: Omit<GoalResultRow, "id" | "created_at"> &
          Partial<Pick<GoalResultRow, "id" | "created_at">>;
        Update: Updatable<GoalResultRow>;
      };
      tag_mappings: { Row: TagMappingRow; Insert: Insertable<TagMappingRow>; Update: Updatable<TagMappingRow> };
      inbound_webhook_sources: {
        Row: InboundWebhookSourceRow;
        // last_used_at / rotated_at (0038) nullable con default NULL:
        // opcionales en Insert (se pueblan en runtime, no al crear la fila).
        Insert: Omit<Insertable<InboundWebhookSourceRow>, "last_used_at" | "rotated_at"> &
          Partial<Pick<InboundWebhookSourceRow, "last_used_at" | "rotated_at">>;
        Update: Updatable<InboundWebhookSourceRow>;
      };
      integration_connections: {
        Row: IntegrationConnectionRow;
        // Todo lo que no es (organization_id, provider) tiene DEFAULT en SQL
        // (0046) → opcional en Insert. La fila nace vacía y la va poblando el
        // admin desde la pantalla (ERRORES.md "Insertable exige TODA columna").
        Insert: Pick<IntegrationConnectionRow, "organization_id" | "provider"> &
          Partial<Omit<IntegrationConnectionRow, "organization_id" | "provider">>;
        Update: Updatable<IntegrationConnectionRow>;
      };
    };
    Views: Record<string, never>;
    Functions: {
      bootstrap_organization: {
        Args: {
          p_name: string;
          p_slug: string;
          p_shopify_store_url?: string | null;
          p_shopify_domain?: string | null;
          p_whaapy_business?: string | null;
        };
        Returns: UUID;
      };
      current_organization_id: {
        Args: Record<string, never>;
        Returns: UUID | null;
      };
      assert_organization_context: {
        Args: Record<string, never>;
        Returns: UUID;
      };
      is_member_of: {
        Args: { p_org: UUID };
        Returns: boolean;
      };
      /** Dry-run READ-ONLY del reemplazo de conexión (0046). */
      count_integration_linked_rows: {
        Args: { p_organization_id: UUID; p_provider: IntegrationProvider };
        Returns: Json;
      };
      /** Reemplazo ATÓMICO de conexión: discriminador + desenlace + Vault (0046). */
      replace_integration_connection: {
        Args: {
          p_organization_id: UUID;
          p_provider: IntegrationProvider;
          p_new_discriminator: string;
          p_actor_user_id?: UUID | null;
          p_new_store_url?: string | null;
        };
        Returns: Json;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
