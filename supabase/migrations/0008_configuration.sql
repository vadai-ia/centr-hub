-- ============================================================
-- M1 · 0008 — Grupo G: Configuración
-- ============================================================
-- goals + tag_mappings.
-- La configuración operativa de la organización (umbrales,
-- defaults) vive como bloque JSONB en `organizations.config`
-- (decisión O3: pocos campos estables, bloque consolidado).
-- ============================================================

-- ------------------------------------------------------------
-- goals — metas de revenue por periodo
-- Solo Funnel Venta tiene metas.
-- ------------------------------------------------------------
create table public.goals (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  user_id                  uuid references public.user_profiles(id) on delete cascade,   -- null = meta global de la org
  period_type              text not null check (period_type in ('monthly', 'quarterly', 'annual')),
  period_start             date not null,
  period_end               date not null,
  amount_target            numeric(12, 2) not null check (amount_target >= 0),
  count_target             integer check (count_target is null or count_target >= 0),
  created_by_user_id       uuid references public.user_profiles(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint goals_period_order check (period_end >= period_start)
);

create trigger goals_set_updated_at
  before update on public.goals
  for each row execute function public.tg_set_updated_at();

create index goals_org_idx               on public.goals (organization_id);
create index goals_org_user_period_idx   on public.goals (organization_id, user_id, period_start);
create index goals_org_period_idx        on public.goals (organization_id, period_start, period_end);

-- ------------------------------------------------------------
-- tag_mappings — clasificación binaria de tags Shopify
-- ------------------------------------------------------------
create table public.tag_mappings (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  normalized_tag           citext not null,                       -- lowercase + trim
  original_tag             text not null,                         -- preservado tal como llegó
  classification           text not null check (classification in ('vendor', 'informational')),
  mapped_membership_id     uuid references public.memberships(id) on delete set null,
  created_by_user_id       uuid references public.user_profiles(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint tag_mappings_org_tag_unique unique (organization_id, normalized_tag),

  -- Mapeo a vendedor requiere clasificación 'vendor'. Una tag
  -- 'informational' nunca tiene membership asociada.
  constraint tag_mappings_vendor_requires_membership check (
    classification = 'vendor' or mapped_membership_id is null
  )
);

create trigger tag_mappings_set_updated_at
  before update on public.tag_mappings
  for each row execute function public.tg_set_updated_at();

create index tag_mappings_org_idx              on public.tag_mappings (organization_id);
create index tag_mappings_org_classification_idx
  on public.tag_mappings (organization_id, classification);
create index tag_mappings_membership_idx
  on public.tag_mappings (mapped_membership_id)
  where mapped_membership_id is not null;
