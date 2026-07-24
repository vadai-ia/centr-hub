-- ============================================================
-- Outbound · 0040 — Tercer funnel 'outbound' + marca outbound/inbound
-- ============================================================
-- Feature "Pipeline Outbound y atribución outbound/inbound" — Fase 1
-- (Fundaciones). Dos cambios estructurales, ambos backbone:
--
--   1. Ampliar el dominio de `funnel` de {'venta','post_venta'} a
--      {'venta','post_venta','outbound'} en las TRES tablas que lo
--      restringen (pipeline_stages, opportunities, automation_rules) +
--      extender `opportunities_parent_funnel_check` para que 'outbound'
--      sea raíz (parent NULL, igual que 'venta'). El handoff Outbound→Venta
--      (Fase 3) será un flip in-place; por eso Outbound vive como valor de
--      funnel, no como tabla/tab aparte.
--
--   2. Marca outbound: fuente de verdad `contacts.is_outbound` (permanente,
--      des-marcable solo por admin con audit — Fase 2), denormalizada a
--      `opportunities.is_outbound` (el dashboard lee filas de opp y no
--      joina contactos) y a `orders.is_outbound` (el revenue sale de
--      `orders`, que no joina opps). El estampado al crear opp lo cablea
--      la Fase 1 (birth-stamping); el de orders, la Fase 4.
--
-- NO se tocan datos existentes: no hay filas 'outbound' todavía y las
-- columnas nacen NOT NULL DEFAULT false (todo lo actual = inbound).
-- ============================================================


-- ------------------------------------------------------------
-- 1) Ampliar el CHECK de `funnel` en las tres tablas
-- ------------------------------------------------------------
-- Los CHECK inline de columna (0004/0006) se auto-nombran
-- `{tabla}_funnel_check`. Se sueltan y re-crean con el dominio ampliado.
alter table public.pipeline_stages
  drop constraint if exists pipeline_stages_funnel_check;
alter table public.pipeline_stages
  add constraint pipeline_stages_funnel_check
  check (funnel in ('venta', 'post_venta', 'outbound'));

alter table public.opportunities
  drop constraint if exists opportunities_funnel_check;
alter table public.opportunities
  add constraint opportunities_funnel_check
  check (funnel in ('venta', 'post_venta', 'outbound'));

alter table public.automation_rules
  drop constraint if exists automation_rules_funnel_check;
alter table public.automation_rules
  add constraint automation_rules_funnel_check
  check (funnel in ('venta', 'post_venta', 'outbound'));


-- ------------------------------------------------------------
-- 2) Extender parent_funnel_check: 'outbound' es raíz (parent NULL)
-- ------------------------------------------------------------
-- Invariante v5.0: venta ⇒ parent NULL; post_venta ⇒ parent NOT NULL.
-- v5.2: outbound ⇒ parent NULL (raíz, como venta). El handoff Outbound→
-- Venta (Fase 3) es un UPDATE funnel='venta' con parent NULL → válido en
-- ambos lados de la constraint.
alter table public.opportunities
  drop constraint if exists opportunities_parent_funnel_check;
alter table public.opportunities
  add constraint opportunities_parent_funnel_check check (
    (funnel = 'venta'      and parent_opportunity_id is null) or
    (funnel = 'outbound'   and parent_opportunity_id is null) or
    (funnel = 'post_venta' and parent_opportunity_id is not null)
  );


-- ------------------------------------------------------------
-- 3) Marca outbound — columnas denormalizadas
-- ------------------------------------------------------------
alter table public.contacts
  add column if not exists is_outbound boolean not null default false;

alter table public.opportunities
  add column if not exists is_outbound boolean not null default false;

alter table public.orders
  add column if not exists is_outbound boolean not null default false;

comment on column public.contacts.is_outbound is
  'Marca outbound (0040) — FUENTE DE VERDAD. true = contacto trabajado por '
  'el SDR en el pipeline Outbound. Permanente (solo admin des-marca, con '
  'audit). Se denormaliza a opportunities/orders para métricas.';
comment on column public.opportunities.is_outbound is
  'Marca outbound denormalizada (0040) desde el contacto. Se estampa al '
  'crear la opp (birth-stamping) y al convertir el contacto (solo opps no '
  'terminales — decisión operador: retroactividad "solo activas y futuras").';
comment on column public.orders.is_outbound is
  'Marca outbound denormalizada (0040) para el split de revenue del '
  'dashboard. El estampado se cablea en la Fase 4.';

-- Índices parciales: los outbound son minoría; las vistas (Mi Día del SDR,
-- filtros de contactos, breakdown del dashboard) filtran is_outbound=true.
create index if not exists contacts_org_outbound_idx
  on public.contacts (organization_id)
  where is_outbound = true;

create index if not exists opportunities_org_outbound_idx
  on public.opportunities (organization_id)
  where is_outbound = true;
