-- ============================================================
-- M1 · 0004 — Grupo C: Pipeline (venta + post-venta)
-- ============================================================
-- pipeline_stages, loss_reasons, opportunities, opportunity_line_items,
-- opportunity_stage_history. Sección 3.3.4 del Master Document.
-- ============================================================

-- ------------------------------------------------------------
-- pipeline_stages
-- ------------------------------------------------------------
create table public.pipeline_stages (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  funnel                  text not null check (funnel in ('venta', 'post_venta')),
  name                    text not null,
  position                integer not null,
  color                   text not null default '#94A3B8',
  default_probability     numeric(5, 2),                       -- solo se usa en Funnel Venta
  is_initial              boolean not null default false,
  is_won                  boolean not null default false,
  is_lost                 boolean not null default false,
  requires_loss_reason    boolean not null default false,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create trigger pipeline_stages_set_updated_at
  before update on public.pipeline_stages
  for each row execute function public.tg_set_updated_at();

create index pipeline_stages_org_funnel_idx on public.pipeline_stages (organization_id, funnel, position);

-- Una sola etapa inicial por (organización, funnel).
create unique index pipeline_stages_one_initial_per_funnel_idx
  on public.pipeline_stages (organization_id, funnel)
  where is_initial = true;

-- ------------------------------------------------------------
-- loss_reasons
-- ------------------------------------------------------------
create table public.loss_reasons (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  name              text not null,
  description       text,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger loss_reasons_set_updated_at
  before update on public.loss_reasons
  for each row execute function public.tg_set_updated_at();

create index loss_reasons_org_idx on public.loss_reasons (organization_id);

-- ------------------------------------------------------------
-- opportunities
-- ------------------------------------------------------------
create table public.opportunities (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  funnel                   text not null check (funnel in ('venta', 'post_venta')),
  stage_id                 uuid not null references public.pipeline_stages(id) on delete restrict,
  contact_id               uuid not null references public.contacts(id) on delete restrict,
  assigned_advisor_id      uuid references public.memberships(id) on delete set null,
  parent_opportunity_id    uuid references public.opportunities(id) on delete restrict,
  shopify_draft_order_id   text,
  shopify_order_id         text,
  display_reference        text,                                -- "#D123"
  actual_amount            numeric(12, 2),                      -- proveniente de Shopify
  estimated_amount         numeric(12, 2),                      -- captura manual antes de Draft Order
  currency                 text not null default 'MXN',
  probability_override     numeric(5, 2),
  weighted_amount          numeric(12, 2),                      -- calculado, solo Funnel Venta
  loss_reason_id           uuid references public.loss_reasons(id) on delete restrict,
  invoice_url              text,
  note                     text,
  shipping_address         jsonb,
  last_modified_at         timestamptz not null default now(),
  last_modified_source     text not null default 'platform',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  won_at                   timestamptz,
  invoice_sent_at          timestamptz,

  -- R1 + 3.3.4: Funnel Venta no tiene parent; Funnel Post-venta sí.
  constraint opportunities_parent_funnel_check check (
    (funnel = 'venta'      and parent_opportunity_id is null) or
    (funnel = 'post_venta' and parent_opportunity_id is not null)
  ),

  constraint opportunities_org_draft_order_unique
    unique (organization_id, shopify_draft_order_id)
);

create trigger opportunities_set_updated_at
  before update on public.opportunities
  for each row execute function public.tg_set_updated_at();

create index opportunities_org_idx              on public.opportunities (organization_id);
create index opportunities_org_funnel_stage_idx on public.opportunities (organization_id, funnel, stage_id);
create index opportunities_contact_idx          on public.opportunities (contact_id);
create index opportunities_advisor_idx          on public.opportunities (assigned_advisor_id);
create index opportunities_parent_idx           on public.opportunities (parent_opportunity_id)
  where parent_opportunity_id is not null;
create index opportunities_draft_order_idx      on public.opportunities (organization_id, shopify_draft_order_id)
  where shopify_draft_order_id is not null;

-- ------------------------------------------------------------
-- opportunity_line_items
-- ------------------------------------------------------------
create table public.opportunity_line_items (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  opportunity_id           uuid not null references public.opportunities(id) on delete cascade,
  shopify_product_id       text,
  shopify_variant_id       text,
  title                    text not null,
  sku                      text,
  quantity                 integer not null check (quantity >= 0),
  variant_title            text,
  original_unit_price      numeric(12, 2) not null,
  discount_amount          numeric(12, 2) not null default 0,
  final_price              numeric(12, 2) not null,
  weight_grams             numeric(12, 2),
  taxable                  boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create trigger opportunity_line_items_set_updated_at
  before update on public.opportunity_line_items
  for each row execute function public.tg_set_updated_at();

create index opportunity_line_items_opportunity_idx on public.opportunity_line_items (opportunity_id);
create index opportunity_line_items_org_idx         on public.opportunity_line_items (organization_id);

-- ------------------------------------------------------------
-- opportunity_stage_history — inmutable
-- ------------------------------------------------------------
create table public.opportunity_stage_history (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  opportunity_id           uuid not null references public.opportunities(id) on delete cascade,
  from_stage_id            uuid references public.pipeline_stages(id) on delete set null,
  to_stage_id              uuid not null references public.pipeline_stages(id) on delete restrict,
  changed_by_user_id       uuid references public.user_profiles(id) on delete set null,
  context                  text not null check (context in ('manual', 'webhook', 'automation', 'trigger_f1_f2', 'seed', 'backfill')),
  changed_at               timestamptz not null default now()
);

create index opportunity_stage_history_opportunity_idx
  on public.opportunity_stage_history (opportunity_id, changed_at desc);
create index opportunity_stage_history_org_idx
  on public.opportunity_stage_history (organization_id);

-- Inmutabilidad: bloquear UPDATE y DELETE.
create or replace function public.tg_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'immutable_table: % no acepta % (audit trail)', TG_TABLE_NAME, TG_OP
    using errcode = 'P0001';
  return null;
end;
$$;

create trigger opportunity_stage_history_no_update
  before update or delete on public.opportunity_stage_history
  for each row execute function public.tg_block_mutation();
