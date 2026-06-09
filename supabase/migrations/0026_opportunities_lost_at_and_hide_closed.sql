-- ============================================================
-- Fix pipeline · 0026 — lost_at + umbral de auto-ocultar cerradas
-- ============================================================
-- Parte 1 del milestone "Fix de pipeline" (anti-ruido): las opps
-- Ganadas y Perdidas se ocultan del kanban tras X días de su cierre
-- (default 7, configurable por admin). Es SOLO visualización del
-- kanban — NO borra, NO cambia etapa, NO cancela, y NO afecta los
-- KPIs del dashboard (que cuentan por sus propias queries).
--
-- Esta migración aporta lo que la app necesita para ese filtro:
--
--   1) `opportunities.lost_at timestamptz` — espejo de `won_at` para
--      las Perdidas. Hoy NO existe: "Perdida" solo vive como entrada
--      en `opportunity_stage_history`. Sin una columna materializada,
--      el kanban tendría que cruzar el historial en cada render
--      (caro — reintroduce el lag de M5-DT-03). La columna se puebla
--      hacia adelante en `pipeline-move.ts` (simétrico a won_at) y se
--      backfillea aquí desde el historial real.
--
--   2) Índices parciales sobre (organization_id, stage_id, won_at) y
--      (…, lost_at) para que el filtro "cerrada hace < N días" sea una
--      búsqueda indexada, no un scan.
--
--   3) Seed de `config.pipeline.hide_closed_after_days = 7` en las orgs
--      existentes. El valor vive en el bloque de config operativa (O3),
--      editable por el admin desde el propio pipeline. La app lee con
--      fallback a 7 si la clave faltara (orgs nuevas no necesitan tocar
--      el bootstrap RPC).
--
-- NULL-handling: una opp cerrada con timestamp NULL (won_at/lost_at
-- desconocido — ej. una Perdida histórica sin entrada de historial) NO
-- se oculta. La app trata NULL como "mostrar" para no esconder algo
-- cuya antigüedad no podemos determinar.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Columna lost_at
-- ------------------------------------------------------------
alter table public.opportunities
  add column if not exists lost_at timestamptz;

comment on column public.opportunities.lost_at is
  'Momento en que la opp entró a una etapa Perdida (espejo de won_at). '
  'Lo setea pipeline-move al mover a etapa is_lost; NULL si nunca se perdió. '
  'Usado por el auto-ocultar del kanban (0026). No afecta KPIs.';

-- ------------------------------------------------------------
-- 2) Backfill desde el historial real (inmutable, fuente de verdad).
--    Solo opps cuya etapa ACTUAL es Perdida: lost_at = el changed_at
--    más reciente de una transición HACIA una etapa is_lost. Si no hay
--    tal entrada (caso raro: perdida sembrada sin historial), queda
--    NULL → no se ocultará (se muestra por defecto).
-- ------------------------------------------------------------
update public.opportunities o
set lost_at = sub.changed_at
from (
       select h.opportunity_id, max(h.changed_at) as changed_at
       from public.opportunity_stage_history h
       join public.pipeline_stages s on s.id = h.to_stage_id
       where s.is_lost = true
       group by h.opportunity_id
     ) sub,
     public.pipeline_stages cur
where sub.opportunity_id = o.id
  and cur.id = o.stage_id
  and cur.is_lost = true
  and o.lost_at is null
  and sub.changed_at is not null;

-- ------------------------------------------------------------
-- 3) Índices parciales para el filtro de auto-ocultar.
--    Cubren "opps activas de una etapa cerrada, ordenadas/filtradas
--    por la fecha de cierre". `cancelled_at is null` alinea con el
--    índice activo existente (0014).
-- ------------------------------------------------------------
create index if not exists opportunities_won_at_idx
  on public.opportunities (organization_id, stage_id, won_at desc)
  where cancelled_at is null and won_at is not null;

create index if not exists opportunities_lost_at_idx
  on public.opportunities (organization_id, stage_id, lost_at desc)
  where cancelled_at is null and lost_at is not null;

-- ------------------------------------------------------------
-- 4) Seed del umbral en orgs existentes (idempotente). No pisa un
--    valor ya configurado por el admin.
-- ------------------------------------------------------------
update public.organizations
set config = jsonb_set(
  config,
  '{pipeline}',
  coalesce(config -> 'pipeline', '{}'::jsonb)
    || jsonb_build_object('hide_closed_after_days', 7),
  true
)
where not (coalesce(config -> 'pipeline', '{}'::jsonb) ? 'hide_closed_after_days');
