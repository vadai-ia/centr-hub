-- ============================================================
-- M1 · 0006 — Grupo E: Motor de automatización
-- ============================================================
-- automation_rules + rule_executions. Sección 3.3.6 del Master Document.
-- Los payloads de `trigger_config`, `conditions` y `actions` viven
-- como JSONB con `schema_version` embebido (guardrail en 3.3.6).
-- La validación con Zod (Sección 3.2) la ejecuta el motor M8 al
-- recibir input — el schema SQL no impone forma de los JSONB.
-- ============================================================

create table public.automation_rules (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  funnel                   text not null check (funnel in ('venta', 'post_venta')),
  name                     text not null,
  description              text,
  is_active                boolean not null default true,
  is_template              boolean not null default false,        -- pre-cargadas = plantillas editables
  trigger_type             text not null check (trigger_type in (
    'stage_aging',
    'no_activity',
    'created',
    'stage_changed',
    'won',
    'lost',
    'contact.created',
    'contact.no_activity'
  )),
  trigger_config           jsonb not null default '{}'::jsonb,
  conditions               jsonb not null default '[]'::jsonb,
  actions                  jsonb not null default '[]'::jsonb,
  schema_version           text not null default 'v1',
  created_by_user_id       uuid references public.user_profiles(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create trigger automation_rules_set_updated_at
  before update on public.automation_rules
  for each row execute function public.tg_set_updated_at();

create index automation_rules_org_idx           on public.automation_rules (organization_id);
create index automation_rules_org_funnel_active on public.automation_rules (organization_id, funnel)
  where is_active = true;
create index automation_rules_trigger_type_idx  on public.automation_rules (trigger_type);

-- ------------------------------------------------------------
-- rule_executions — inmutable
-- ------------------------------------------------------------
create table public.rule_executions (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  rule_id                  uuid not null references public.automation_rules(id) on delete cascade,
  opportunity_id           uuid references public.opportunities(id) on delete set null,
  contact_id               uuid references public.contacts(id) on delete set null,
  status                   text not null check (status in ('success', 'failed', 'skipped')),
  result                   jsonb not null default '{}'::jsonb,
  executed_at              timestamptz not null default now()
);

create index rule_executions_org_idx        on public.rule_executions (organization_id, executed_at desc);
create index rule_executions_rule_idx       on public.rule_executions (rule_id, executed_at desc);
create index rule_executions_opportunity_idx
  on public.rule_executions (opportunity_id, executed_at desc)
  where opportunity_id is not null;
create index rule_executions_contact_idx
  on public.rule_executions (contact_id, executed_at desc)
  where contact_id is not null;

create trigger rule_executions_no_update
  before update or delete on public.rule_executions
  for each row execute function public.tg_block_mutation();
