-- ============================================================
-- M1 · 0002 — Grupo A: Multi-tenancy
-- ============================================================
-- organizations, user_profiles (extiende auth.users), memberships.
-- Sección 3.3.2 del Master Document.
-- ============================================================

-- ------------------------------------------------------------
-- organizations — tenant raíz
-- ------------------------------------------------------------
create table public.organizations (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  slug                  citext not null unique,
  shopify_store_url     text,
  shopify_store_domain  text,
  whaapy_business_id    text,
  branding              jsonb not null default '{}'::jsonb,   -- logo, colors (O9)
  -- bloque de configuración operativa (O3): umbrales, defaults
  config                jsonb not null default jsonb_build_object(
    'thresholds', jsonb_build_object(
      'coverage_green_pct',    300,
      'coverage_yellow_pct',   200,
      'compliance_green_pct',  100,
      'compliance_yellow_pct',  90,
      'win_rate_min_sample',    10
    ),
    'defaults', jsonb_build_object(
      'currency', 'MXN'
    )
  ),
  vault_keys            jsonb not null default '{}'::jsonb,  -- refs a Supabase Vault, no las keys
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint organizations_shopify_url_unique  unique (shopify_store_url),
  constraint organizations_shopify_domain_unique unique (shopify_store_domain),
  constraint organizations_whaapy_business_unique unique (whaapy_business_id)
);

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.tg_set_updated_at();

-- ------------------------------------------------------------
-- user_profiles — extiende auth.users con metadata de plataforma
-- ------------------------------------------------------------
create table public.user_profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  full_name         text not null,
  phone             text,
  avatar_url        text,
  color             text not null default '#6B7280',           -- gris neutral por default
  is_system_user    boolean not null default false,            -- O10 / R10
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger user_profiles_set_updated_at
  before update on public.user_profiles
  for each row execute function public.tg_set_updated_at();

create index user_profiles_is_system_user_idx
  on public.user_profiles (is_system_user)
  where is_system_user = true;

-- ------------------------------------------------------------
-- memberships — puente usuario ↔ organización
-- ------------------------------------------------------------
create table public.memberships (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.user_profiles(id) on delete cascade,
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  role              text not null check (role in ('superadmin', 'admin', 'vendedor')),
  is_active         boolean not null default true,
  whaapy_agent_id   text,                                       -- contraparte en Whaapy (opcional)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint memberships_user_org_unique unique (user_id, organization_id)
);

create trigger memberships_set_updated_at
  before update on public.memberships
  for each row execute function public.tg_set_updated_at();

create index memberships_organization_idx on public.memberships (organization_id);
create index memberships_user_idx          on public.memberships (user_id);
create index memberships_org_active_role_idx
  on public.memberships (organization_id, role)
  where is_active = true;

-- ------------------------------------------------------------
-- Helper: ¿el usuario actual pertenece a esta organización?
-- Útil para políticas RLS de memberships (donde no hay todavía
-- una org "activa" elegida — el usuario podría estar listando
-- sus orgs disponibles antes de elegir una).
-- ------------------------------------------------------------
create or replace function public.is_member_of(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.memberships m
     where m.organization_id = p_org
       and m.user_id = auth.uid()
       and m.is_active = true
  );
$$;
