-- ============================================================
-- M1 · 0005 — Grupo D: Órdenes
-- ============================================================
-- orders + order_line_items. Sección 3.3.5 del Master Document.
-- ============================================================

create table public.orders (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  contact_id               uuid not null references public.contacts(id) on delete restrict,
  assigned_advisor_id      uuid references public.memberships(id) on delete set null,
  opportunity_id           uuid references public.opportunities(id) on delete set null,   -- O6: huérfanas válidas
  shopify_order_id         text not null,
  shopify_name             text,                                  -- "#1234"
  financial_status         text not null,                         -- paid, pending, refunded, partially_paid, partially_refunded
  fulfillment_status       text,                                  -- unfulfilled, partial, fulfilled, etc.
  total_amount             numeric(12, 2) not null,               -- R5: revenue real
  subtotal                 numeric(12, 2) not null default 0,
  taxes_amount             numeric(12, 2) not null default 0,
  shipping_amount          numeric(12, 2) not null default 0,
  discount_amount          numeric(12, 2) not null default 0,
  currency                 text not null default 'MXN',
  cancellation_reason      text,
  source                   text,                                  -- web, pos, draft_order, etc.
  shopify_tags             text[] not null default '{}',
  last_modified_at         timestamptz not null default now(),
  last_modified_source     text not null default 'shopify',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  paid_at                  timestamptz,
  cancelled_at             timestamptz,

  constraint orders_org_shopify_order_unique unique (organization_id, shopify_order_id)
);

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.tg_set_updated_at();

create index orders_org_idx                on public.orders (organization_id);
create index orders_contact_idx            on public.orders (contact_id);
create index orders_advisor_idx            on public.orders (assigned_advisor_id);
create index orders_opportunity_idx        on public.orders (opportunity_id)
  where opportunity_id is not null;
create index orders_org_paid_at_idx        on public.orders (organization_id, paid_at desc)
  where financial_status = 'paid';
create index orders_org_financial_status_idx on public.orders (organization_id, financial_status);

-- ------------------------------------------------------------
-- order_line_items
-- ------------------------------------------------------------
create table public.order_line_items (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  order_id                 uuid not null references public.orders(id) on delete cascade,
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

create trigger order_line_items_set_updated_at
  before update on public.order_line_items
  for each row execute function public.tg_set_updated_at();

create index order_line_items_order_idx on public.order_line_items (order_id);
create index order_line_items_org_idx   on public.order_line_items (organization_id);
