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

export type Funnel = "venta" | "post_venta";
export type Role = "superadmin" | "admin" | "vendedor";
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
  role: Role;
  is_active: boolean;
  whaapy_agent_id: string | null;
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
  invoice_sent_at: ISODateString | null;
  // Cancelación administrativa (0014). cancelled_at IS NULL → activa.
  // cancellation_source: 'shopify_draft_deleted' | 'admin_manual' |
  //                      'system_other' (string libre, extensible).
  cancelled_at: ISODateString | null;
  cancellation_source: string | null;
  cancellation_note: string | null;
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

export interface GoalRow {
  id: UUID;
  organization_id: UUID;
  user_id: UUID | null;
  period_type: "monthly" | "quarterly" | "annual";
  period_start: string; // date
  period_end: string;
  amount_target: Numeric;
  count_target: number | null;
  created_by_user_id: UUID | null;
  created_at: ISODateString;
  updated_at: ISODateString;
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
type Insertable<R extends { id: UUID; created_at: ISODateString; updated_at: ISODateString }> =
  Omit<R, "id" | "created_at" | "updated_at"> &
    Partial<Pick<R, "id" | "created_at" | "updated_at">>;

type Updatable<R> = Partial<R>;

export interface Database {
  public: {
    Tables: {
      organizations: { Row: OrganizationRow; Insert: Insertable<OrganizationRow>; Update: Updatable<OrganizationRow> };
      user_profiles: { Row: UserProfileRow; Insert: Insertable<UserProfileRow>; Update: Updatable<UserProfileRow> };
      memberships: { Row: MembershipRow; Insert: Insertable<MembershipRow>; Update: Updatable<MembershipRow> };
      contacts: { Row: ContactRow; Insert: Insertable<ContactRow>; Update: Updatable<ContactRow> };
      pipeline_stages: { Row: PipelineStageRow; Insert: Insertable<PipelineStageRow>; Update: Updatable<PipelineStageRow> };
      loss_reasons: { Row: LossReasonRow; Insert: Insertable<LossReasonRow>; Update: Updatable<LossReasonRow> };
      opportunities: { Row: OpportunityRow; Insert: Insertable<OpportunityRow>; Update: Updatable<OpportunityRow> };
      opportunity_line_items: { Row: OpportunityLineItemRow; Insert: Insertable<OpportunityLineItemRow>; Update: Updatable<OpportunityLineItemRow> };
      opportunity_stage_history: {
        Row: OpportunityStageHistoryRow;
        Insert: Omit<OpportunityStageHistoryRow, "id" | "changed_at"> & Partial<Pick<OpportunityStageHistoryRow, "id" | "changed_at">>;
        Update: Updatable<OpportunityStageHistoryRow>;
      };
      orders: { Row: OrderRow; Insert: Insertable<OrderRow>; Update: Updatable<OrderRow> };
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
      tasks: { Row: TaskRow; Insert: Insertable<TaskRow>; Update: Updatable<TaskRow> };
      notifications: { Row: NotificationRow; Insert: Insertable<NotificationRow>; Update: Updatable<NotificationRow> };
      audit_log: {
        Row: AuditLogRow;
        Insert: Omit<AuditLogRow, "id" | "created_at"> & Partial<Pick<AuditLogRow, "id" | "created_at">>;
        Update: Updatable<AuditLogRow>;
      };
      goals: { Row: GoalRow; Insert: Insertable<GoalRow>; Update: Updatable<GoalRow> };
      tag_mappings: { Row: TagMappingRow; Insert: Insertable<TagMappingRow>; Update: Updatable<TagMappingRow> };
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
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
