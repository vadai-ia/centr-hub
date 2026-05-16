-- ============================================================
-- M1 · 0003 — Grupo B: Contactos
-- ============================================================
-- contacts: base maestra (Observación O11). Identidades externas
-- como columnas inline (Shopify + Whaapy) — decisión de modelado
-- aprobada en O11 para MVP.
--
-- Metadata de last-write-wins POR CAMPO (R3) vive en `field_metadata`
-- como JSONB. Estructura ejemplo:
--   {
--     "full_name": { "updated_at": "...", "source": "shopify" },
--     "email":     { "updated_at": "...", "source": "whaapy" },
--     ...
--   }
-- El reconciliador del lado de aplicación (M3/M4) decide qué
-- update aplicar comparando timestamps por campo.
-- ============================================================

create table public.contacts (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,

  -- datos identificables (anonimizables por ARCO — R9)
  full_name               text,
  email                   citext,                    -- normalizado lowercase
  phone                   text,                      -- normalizado E.164
  address                 jsonb,
  internal_note           text,

  -- metadata Shopify (informativa)
  shopify_tags            text[] not null default '{}',
  shopify_state           text,                      -- habilitado / deshabilitado / etc.

  -- asignación
  assigned_advisor_id     uuid references public.memberships(id) on delete set null,

  -- identidades externas (O11)
  shopify_customer_id     text,
  whaapy_contact_id       text,

  -- LWW por campo (R3)
  field_metadata          jsonb not null default '{}'::jsonb,

  -- defensa anti-bucle (R11 opción B — última escritura outbound propia)
  last_modified_at        timestamptz not null default now(),
  last_modified_source    text not null default 'platform',

  -- flags operativos
  missing_phone           boolean not null default false,    -- Discovery 2 #14
  deleted_in_shopify      boolean not null default false,    -- R8
  deleted_in_whaapy       boolean not null default false,    -- R8
  anonymized_at           timestamptz,                       -- R9

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint contacts_org_shopify_customer_unique
    unique (organization_id, shopify_customer_id),
  constraint contacts_org_whaapy_contact_unique
    unique (organization_id, whaapy_contact_id)
);

create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function public.tg_set_updated_at();

create index contacts_organization_idx        on public.contacts (organization_id);
create index contacts_assigned_advisor_idx    on public.contacts (assigned_advisor_id);
create index contacts_email_idx               on public.contacts (organization_id, email)
  where email is not null;
create index contacts_phone_idx               on public.contacts (organization_id, phone)
  where phone is not null;
create index contacts_shopify_customer_idx    on public.contacts (organization_id, shopify_customer_id)
  where shopify_customer_id is not null;
create index contacts_whaapy_contact_idx      on public.contacts (organization_id, whaapy_contact_id)
  where whaapy_contact_id is not null;
create index contacts_missing_phone_idx       on public.contacts (organization_id)
  where missing_phone = true;
create index contacts_last_modified_at_idx    on public.contacts (organization_id, last_modified_at desc);
