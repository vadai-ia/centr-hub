-- ============================================================
-- M1 · 0007 — Grupo F: Operativo
-- ============================================================
-- activities (timeline), tasks, notifications, audit_log.
-- Sección 3.3.7 del Master Document.
-- ============================================================

-- ------------------------------------------------------------
-- activities — timeline unificado · inmutable
-- ------------------------------------------------------------
create table public.activities (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  contact_id               uuid references public.contacts(id) on delete cascade,
  opportunity_id           uuid references public.opportunities(id) on delete cascade,
  activity_type            text not null,
  description              text not null,
  payload                  jsonb not null default '{}'::jsonb,
  triggered_by_user_id     uuid references public.user_profiles(id) on delete set null,
  created_at               timestamptz not null default now(),

  -- al menos una de las dos referencias debe estar presente
  constraint activities_at_least_one_subject check (
    contact_id is not null or opportunity_id is not null
  )
);

create index activities_org_idx              on public.activities (organization_id, created_at desc);
create index activities_contact_idx          on public.activities (contact_id, created_at desc)
  where contact_id is not null;
create index activities_opportunity_idx      on public.activities (opportunity_id, created_at desc)
  where opportunity_id is not null;
create index activities_type_idx             on public.activities (organization_id, activity_type);

create trigger activities_no_update
  before update or delete on public.activities
  for each row execute function public.tg_block_mutation();

-- ------------------------------------------------------------
-- tasks
-- ------------------------------------------------------------
create table public.tasks (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  contact_id               uuid references public.contacts(id) on delete cascade,
  opportunity_id           uuid references public.opportunities(id) on delete cascade,
  assigned_user_id         uuid not null references public.user_profiles(id) on delete restrict,
  task_type                text not null,                          -- call, message, quote, follow_up, ...
  title                    text not null,
  description              text,
  due_at                   timestamptz,
  status                   text not null default 'pending' check (status in ('pending', 'completed', 'snoozed')),
  snoozed_until            timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  completed_at             timestamptz,

  constraint tasks_at_least_one_subject check (
    contact_id is not null or opportunity_id is not null
  )
);

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.tg_set_updated_at();

create index tasks_org_idx                   on public.tasks (organization_id);
create index tasks_assigned_pending_idx      on public.tasks (assigned_user_id, due_at)
  where status = 'pending';
create index tasks_snoozed_idx               on public.tasks (snoozed_until)
  where status = 'snoozed';

-- ------------------------------------------------------------
-- notifications
-- ------------------------------------------------------------
create table public.notifications (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  user_id                  uuid not null references public.user_profiles(id) on delete cascade,
  notification_type        text not null,                          -- call, message, quote, follow_up, alert
  origin                   text not null check (origin in ('rule', 'manual', 'system')),
  origin_reference         jsonb not null default '{}'::jsonb,
  opportunity_id           uuid references public.opportunities(id) on delete cascade,
  contact_id               uuid references public.contacts(id) on delete cascade,
  title                    text not null,
  message                  text not null,
  amount_at_stake          numeric(12, 2),
  due_at                   timestamptz,
  status                   text not null default 'pending' check (status in ('pending', 'completed', 'snoozed', 'dismissed')),
  snoozed_until            timestamptz,
  schema_version           text not null default 'v1',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  completed_at             timestamptz
);

create trigger notifications_set_updated_at
  before update on public.notifications
  for each row execute function public.tg_set_updated_at();

create index notifications_org_idx               on public.notifications (organization_id);
create index notifications_user_pending_idx      on public.notifications (user_id, due_at)
  where status = 'pending';
create index notifications_snoozed_idx           on public.notifications (snoozed_until)
  where status = 'snoozed';

-- ------------------------------------------------------------
-- audit_log — inmutable, conservado indefinidamente
-- ------------------------------------------------------------
create table public.audit_log (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  actor_user_id            uuid references public.user_profiles(id) on delete set null,
  event_type               text not null,                          -- arco_executed, tag_remapped, rule_toggled, sync_loop_prevented, unhandled_whaapy_event, ...
  entity_type              text,                                   -- 'contact', 'opportunity', etc.
  entity_id                uuid,
  payload                  jsonb not null default '{}'::jsonb,
  ip_address               inet,
  created_at               timestamptz not null default now()
);

create index audit_log_org_idx        on public.audit_log (organization_id, created_at desc);
create index audit_log_event_type_idx on public.audit_log (organization_id, event_type, created_at desc);
create index audit_log_entity_idx     on public.audit_log (entity_type, entity_id);

create trigger audit_log_no_update
  before update or delete on public.audit_log
  for each row execute function public.tg_block_mutation();
