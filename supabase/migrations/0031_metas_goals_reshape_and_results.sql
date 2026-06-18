-- ============================================================
-- M2v2 · 0031 — Metas mensuales + umbrales + histórico
-- ============================================================
-- Reshape de `goals` (de "meta de revenue por periodo" del placeholder
-- V2 a "meta MENSUAL recurrente por métrica") + tabla `goal_results`
-- (snapshot histórico mensual) + seed de los umbrales del semáforo en
-- `organizations.config.metas`.
--
-- `goals` no tiene datos productivos ni callers en la app (fue un
-- placeholder de V2 — sus únicas referencias son su definición en 0008
-- y la lista RLS de 0009), por eso el reshape es seguro. Las 4 tenant
-- policies de 0009 (`goals_tenant_*`) filtran solo por organization_id,
-- no por las columnas que se eliminan → siguen válidas.
--
-- Modelo nuevo:
--   - Una meta = (org, vendedor-o-equipo, métrica, objetivo, activa).
--   - `advisor_membership_id` NULL = meta GENERAL de equipo (se compara
--     contra los totales de la org sin filtrar por asesor). No-NULL =
--     meta de ese vendedor (apunta a memberships.id, igual que la
--     atribución `assigned_advisor_id`).
--   - `metric` ∈ quotes | won | amount (cotizaciones enviadas /
--     oportunidades ganadas / monto vendido — reusan los cálculos del
--     Dashboard, no se recomputan).
--   - El periodo es SIEMPRE el mes en curso (CDMX); el avance se
--     reinicia el día 1. El histórico se snapshotea en goal_results.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Reshape de goals
-- ------------------------------------------------------------

-- 1a) Soltar índices/constraint/columnas del modelo viejo.
drop index if exists public.goals_org_user_period_idx;
drop index if exists public.goals_org_period_idx;

alter table public.goals
  drop constraint if exists goals_period_order,
  drop column if exists user_id,
  drop column if exists period_type,
  drop column if exists period_start,
  drop column if exists period_end,
  drop column if exists amount_target,
  drop column if exists count_target;

-- 1b) Columnas del modelo nuevo. Los DEFAULT temporales solo satisfacen
--     NOT NULL si hubiera filas residuales; se sueltan enseguida para
--     que cada insert decida métrica y objetivo conscientemente.
alter table public.goals
  add column if not exists advisor_membership_id uuid
    references public.memberships(id) on delete cascade,
  add column if not exists metric text not null default 'amount'
    check (metric in ('quotes', 'won', 'amount')),
  add column if not exists target_value numeric(14, 2) not null default 0
    check (target_value >= 0),
  add column if not exists is_active boolean not null default true;

alter table public.goals
  alter column metric drop default,
  alter column target_value drop default;

comment on table public.goals is
  'Metas mensuales recurrentes (M2v2). Una fila por (org, vendedor-o-equipo, '
  'métrica). El periodo es SIEMPRE el mes en curso (America/Mexico_City); el '
  'avance se reinicia el día 1. El histórico mensual se snapshotea en goal_results.';
comment on column public.goals.advisor_membership_id is
  'Vendedor dueño de la meta (memberships.id). NULL = meta general de equipo '
  '(se compara contra los totales de la org sin filtrar por asesor).';
comment on column public.goals.metric is
  'Métrica medida: quotes (cotizaciones enviadas) | won (oportunidades ganadas / '
  'órdenes) | amount (monto vendido). Reusa los cálculos del Dashboard.';
comment on column public.goals.target_value is
  'Objetivo mensual. quotes/won = conteo; amount = monto en la moneda de la org.';
comment on column public.goals.is_active is
  'Meta activa. Inactiva = no se evalúa ni se muestra (empty state "sin meta").';

-- 1c) Unicidad: a lo sumo UNA meta por (org, vendedor, métrica) y una por
--     (org, equipo, métrica). Dos índices parciales evitan el sentinel de
--     un COALESCE sobre el NULL de equipo.
create unique index if not exists goals_org_advisor_metric_uniq
  on public.goals (organization_id, advisor_membership_id, metric)
  where advisor_membership_id is not null;

create unique index if not exists goals_org_team_metric_uniq
  on public.goals (organization_id, metric)
  where advisor_membership_id is null;

create index if not exists goals_advisor_idx
  on public.goals (advisor_membership_id)
  where advisor_membership_id is not null;

-- ------------------------------------------------------------
-- 2) goal_results — snapshot histórico mensual (append-only)
-- ------------------------------------------------------------
-- Lo escribe el cron mensual de Inngest al cerrar el mes. Self-contained
-- (guarda métrica/target/logrado/pct) para sobrevivir cambios o borrado
-- de la meta origen. Solo lo consulta el admin.
create table if not exists public.goal_results (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  goal_id               uuid references public.goals(id) on delete set null,
  advisor_membership_id uuid references public.memberships(id) on delete set null,
  metric                text not null check (metric in ('quotes', 'won', 'amount')),
  period_month          date not null,  -- primer día del mes (CDMX), ej. 2026-05-01
  target_value          numeric(14, 2) not null,
  achieved_value        numeric(14, 2) not null,
  pct                   numeric(7, 2) not null,
  created_at            timestamptz not null default now()
);

comment on table public.goal_results is
  'Snapshot histórico del cumplimiento de cada meta al cerrar el mes (M2v2). '
  'Append-only: lo escribe el cron mensual de Inngest. Self-contained para '
  'sobrevivir cambios o borrado de la meta. Solo vista del admin.';
comment on column public.goal_results.period_month is
  'Primer día del mes evaluado en America/Mexico_City (date). Identifica el periodo cerrado.';
comment on column public.goal_results.advisor_membership_id is
  'Vendedor del snapshot (memberships.id). NULL = meta de equipo.';
comment on column public.goal_results.pct is
  'Porcentaje real logrado/objetivo*100 congelado al cierre (puede superar 100).';

-- Una sola foto por (org, vendedor-o-equipo, métrica, mes).
create unique index if not exists goal_results_org_advisor_metric_month_uniq
  on public.goal_results (organization_id, advisor_membership_id, metric, period_month)
  where advisor_membership_id is not null;

create unique index if not exists goal_results_org_team_metric_month_uniq
  on public.goal_results (organization_id, metric, period_month)
  where advisor_membership_id is null;

create index if not exists goal_results_org_month_idx
  on public.goal_results (organization_id, period_month desc);

-- ------------------------------------------------------------
-- 3) RLS de goal_results — las 4 tenant policies estándar (espejo de
--    la macro de 0009; aislamiento por organization_id).
-- ------------------------------------------------------------
alter table public.goal_results enable row level security;

create policy goal_results_tenant_select on public.goal_results
  for select using (organization_id = public.current_organization_id());

create policy goal_results_tenant_insert on public.goal_results
  for insert with check (organization_id = public.current_organization_id());

create policy goal_results_tenant_update on public.goal_results
  for update using (organization_id = public.current_organization_id())
  with check (organization_id = public.current_organization_id());

create policy goal_results_tenant_delete on public.goal_results
  for delete using (organization_id = public.current_organization_id());

-- ------------------------------------------------------------
-- 4) Seed de los umbrales del semáforo en config.metas (idempotente,
--    no pisa un valor ya configurado por el admin). La app lee con
--    fallback a estos mismos defaults si la clave faltara (orgs nuevas
--    no necesitan tocar el bootstrap RPC).
--    Default M2v2: rojo <50% · amarillo 50-84% · verde ≥85% · dorado >100%.
-- ------------------------------------------------------------
update public.organizations
set config = jsonb_set(
  config,
  '{metas}',
  coalesce(config -> 'metas', '{}'::jsonb)
    || jsonb_build_object('green_pct', 85, 'yellow_pct', 50),
  true
)
where not (coalesce(config -> 'metas', '{}'::jsonb) ? 'green_pct');
