-- ============================================================
-- Creación de leads (manual + webhook) · 0038
-- ============================================================
-- Track 1 de la feature "Creación de leads". Dos vías nuevas de creación
-- (manual desde la UI + webhook por fuente externa) comparten un único
-- camino canónico (`lib/services/lead-creation.ts`). Esta migración agrega:
--
--   1. `inbound_webhook_sources` — una fila por fuente externa (formulario
--      de la web, landing de campaña, Zapier/Make, etc.). Cada fuente tiene
--      su propio endpoint (`/api/webhooks/leads/{slug}`) y su propia
--      credencial (token), de modo que se pueda revocar o rotar por
--      separado sin afectar a las demás. El token se guarda HASHEADO
--      (sha256) — el valor crudo se muestra UNA sola vez al crearlo y no se
--      puede recuperar después (patrón "copiar ahora").
--
--   2. `opportunities.lead_source` + `opportunities.inbound_webhook_source_id`
--      — atribución de origen del lead. Se sella al crear la oportunidad
--      "Lead nuevo" desde el camino canónico. NULL en las opps nacidas por
--      otras vías (draft de Shopify, R12, reapertura). La atribución
--      completa (incluido el caso "se dedupó y no se creó opp nueva") vive
--      además en el audit `lead_created`.
-- ============================================================

-- ------------------------------------------------------------
-- 1) inbound_webhook_sources
-- ------------------------------------------------------------
create table if not exists public.inbound_webhook_sources (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  -- Nombre legible de la fuente ("Formulario Home", "Landing Verano 2026").
  name               text not null,
  -- Segmento público de la URL: /api/webhooks/leads/{slug}. GLOBALMENTE
  -- único: el slug por sí solo identifica org + fuente (el endpoint no
  -- lleva otro discriminador). Aleatorio/no adivinable al crearlo.
  slug               text not null,
  -- sha256(hex) del token de la fuente. El token crudo se muestra 1 vez.
  token_hash         text not null,
  -- Últimos 4 chars del token — solo para mostrar en la UI ("••••ab12").
  token_last4        text not null,
  -- Revocar = is_active=false (el endpoint rechaza). Se conserva la fila
  -- para trazabilidad de leads históricos atribuidos a esta fuente.
  is_active          boolean not null default true,
  created_by_user_id uuid references public.user_profiles(id) on delete set null,
  -- Última vez que el endpoint aceptó un evento de esta fuente (métrica
  -- operativa "¿esta fuente sigue viva?").
  last_used_at       timestamptz,
  -- Última rotación del token (el token nuevo reemplaza al viejo).
  rotated_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.inbound_webhook_sources is
  'Fuentes externas de leads por webhook (0038). Una fila por fuente, con '
  'endpoint (slug) y credencial (token hasheado) propios — revocables/rotables '
  'por separado. El token crudo se muestra 1 sola vez al crear/rotar.';
comment on column public.inbound_webhook_sources.slug is
  'Segmento público de /api/webhooks/leads/{slug}. GLOBALMENTE único: resuelve '
  'org + fuente por sí solo. Aleatorio/no adivinable.';
comment on column public.inbound_webhook_sources.token_hash is
  'sha256(hex) del token. Comparación constant-time en el endpoint. El crudo '
  'no se persiste ni se puede recuperar (patrón copiar-ahora).';

-- Slug globalmente único (identifica org+fuente desde la URL sola).
create unique index if not exists inbound_webhook_sources_slug_uniq
  on public.inbound_webhook_sources (slug);
-- Listado del admin por org (más reciente primero).
create index if not exists inbound_webhook_sources_org_idx
  on public.inbound_webhook_sources (organization_id, created_at desc);

create trigger inbound_webhook_sources_set_updated_at
  before update on public.inbound_webhook_sources
  for each row execute function public.tg_set_updated_at();

-- RLS: las 4 tenant policies estándar (espejo de la macro de 0009 /
-- goal_results en 0031; aislamiento por organization_id).
alter table public.inbound_webhook_sources enable row level security;

create policy inbound_webhook_sources_tenant_select on public.inbound_webhook_sources
  for select using (organization_id = public.current_organization_id());

create policy inbound_webhook_sources_tenant_insert on public.inbound_webhook_sources
  for insert with check (organization_id = public.current_organization_id());

create policy inbound_webhook_sources_tenant_update on public.inbound_webhook_sources
  for update using (organization_id = public.current_organization_id())
  with check (organization_id = public.current_organization_id());

create policy inbound_webhook_sources_tenant_delete on public.inbound_webhook_sources
  for delete using (organization_id = public.current_organization_id());

-- ------------------------------------------------------------
-- 2) Atribución de origen en opportunities
-- ------------------------------------------------------------
-- Nullable + default NULL: las opps existentes y las nacidas por otras
-- vías (draft Shopify, R12, reapertura) quedan NULL. El FK on delete set
-- null preserva la opp aunque se borre la fuente (la atribución textual
-- `lead_source` sobrevive).
alter table public.opportunities
  add column if not exists lead_source text,
  add column if not exists inbound_webhook_source_id uuid
    references public.inbound_webhook_sources(id) on delete set null;

comment on column public.opportunities.lead_source is
  'Origen del lead que creó esta oportunidad "Lead nuevo" (0038): '
  '"manual" | "webhook". NULL = nacida por otra vía (draft Shopify, R12, reapertura).';
comment on column public.opportunities.inbound_webhook_source_id is
  'Fuente de webhook específica que originó el lead (0038). NULL para leads '
  'manuales o para opps nacidas por otra vía.';

create index if not exists opportunities_inbound_webhook_source_idx
  on public.opportunities (inbound_webhook_source_id)
  where inbound_webhook_source_id is not null;
