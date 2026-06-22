-- ============================================================
-- Post-venta · 0035 — reapertura de oportunidades a "Caso problemático" (M4v2)
-- ============================================================
-- M4v2 permite REABRIR cualquier oportunidad (de cualquier etapa/funnel,
-- incluidas cerradas/archivadas) hacia "Caso problemático" del Post-venta,
-- para atender un problema reportado sobre un pedido ya cerrado.
--
--   reopened_at  timestamptz  — NULL = la opp llegó a su etapa por el flujo
--                               normal; IS NOT NULL = fue reabierta a "Caso
--                               problemático" desde el botón "+" (marca el
--                               último instante de reapertura).
--
-- Es un FLAG de PROCEDENCIA, ortogonal al estado: una opp reabierta es una
-- opp activa normal (badge "Reabierto" en el card para distinguirla de las
-- que llegaron por el motor). NO cambia la semántica de archivado
-- (cancelled_at/won_at/lost_at/resolved_at) — de hecho la reapertura LIMPIA
-- esos flags (la opp vuelve a estar viva). Ver lib/services para el flujo
-- híbrido (Post-venta se muta en sitio; Venta crea una hija Post-venta).
--
-- nullable + default NULL → opcional en Insert (no rompe callers V1).
-- ============================================================

alter table public.opportunities
  add column if not exists reopened_at timestamptz;

-- Índice parcial: las reabiertas son minoría (vista/badge puntual).
create index if not exists opportunities_org_reopened_idx
  on public.opportunities (organization_id, reopened_at)
  where reopened_at is not null;

comment on column public.opportunities.reopened_at is
  'Reapertura a "Caso problemático" (M4v2). NULL=llegó por flujo normal; IS NOT NULL=reabierta manualmente. Flag de procedencia, ortogonal al estado.';
