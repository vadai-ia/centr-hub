-- ============================================================
-- M3 · 0014 — Cancelación de oportunidades (cancelado ≠ perdido)
-- ============================================================
-- Una oportunidad cuya Draft Order fue eliminada en Shopify NO
-- debe quedar en etapa "Perdida". "Perdida" significa que el
-- vendedor compitió y perdió contra precio/competencia/ghosting/
-- etc. — eso impacta win rate. Una cancelación administrativa
-- (DO borrado por error, duplicado, prueba, o auto-borrado de
-- Shopify después de 1 año de inactividad) NO es una pérdida
-- comercial real y no debe contaminar métricas (R5).
--
-- Modelo elegido (delegación de Claude Code):
--   - `cancelled_at timestamptz` — null = activa; valor = cancelada
--     en ese momento. Patrón alineado con `orders.cancelled_at` y
--     `orders.paid_at` ya existentes (3.3.5).
--   - `cancellation_source text` — origen extensible
--     ('shopify_draft_deleted', 'admin_manual', 'system_other').
--     Sin check constraint estricto: el set puede crecer sin
--     migración.
--   - `cancellation_note text` — nota libre opcional para auditoría.
--
-- La etapa actual se PRESERVA al cancelar — sirve como auditoría
-- ("esta opp estaba en X etapa cuando se canceló"). El worker
-- NO transita de etapa ni agrega entrada al stage history (no
-- hubo cambio de etapa).
--
-- Materialización: índice parcial sobre `cancelled_at IS NULL`
-- para que las queries del pipeline activo (la mayoría) sigan
-- siendo eficientes sin escanear canceladas.
-- ============================================================

alter table public.opportunities
  add column if not exists cancelled_at timestamptz;

alter table public.opportunities
  add column if not exists cancellation_source text;

alter table public.opportunities
  add column if not exists cancellation_note text;

-- Índice parcial para el pipeline activo (kanban M5, queries del
-- vendedor en M6, dashboard M10). Cubre las queries más frecuentes
-- por (organization, funnel, stage) excluyendo canceladas.
create index if not exists opportunities_active_org_funnel_stage_idx
  on public.opportunities (organization_id, funnel, stage_id)
  where cancelled_at is null;

-- Índice complementario para la vista explícita "ver canceladas"
-- (admin debugging, auditoría). Más pequeño en uso real —
-- las canceladas son fracción del total.
create index if not exists opportunities_cancelled_idx
  on public.opportunities (organization_id, cancelled_at desc)
  where cancelled_at is not null;
