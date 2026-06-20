-- ============================================================
-- Post-venta · 0032 — cierre/archivo de "Caso problemático" (M3v2)
-- ============================================================
-- El motor de transiciones (M3v2) manda a "Caso problemático" toda opp
-- de Post-venta cuyo pedido se canceló/reembolsó (cancelled, refunded,
-- partially_refunded). Esa etapa es un SUMIDERO del motor: una vez ahí,
-- el motor no la vuelve a tocar — la resuelve una persona.
--
-- Esta migración aporta el modelo de CIERRE de caso:
--
--   resolved_at         timestamptz  — NULL = caso ABIERTO (visible en
--                                      "Caso problemático"); IS NOT NULL =
--                                      resuelto y ARCHIVADO (fuera del
--                                      pipeline activo).
--   resolved_by_user_id uuid         — quién lo cerró (auditoría).
--   resolution_note     text         — nota opcional de cómo se resolvió.
--
-- Diseño (consistente con "cancelado ≠ perdido", 0014): resolver NO mueve
-- la etapa — la opp se queda en "Caso problemático" (preserva el contexto
-- de auditoría); `resolved_at` es un FLAG ORTOGONAL que la archiva de las
-- vistas activas. El caso archivado sigue siendo localizable (filtro
-- "Casos resueltos" + búsqueda por orden/contacto) con su historia
-- completa (estas columnas + audit_log `postventa_case_resolved` + el
-- opportunity_stage_history que registró el movimiento del motor).
--
-- Semántica SOLO de Post-venta: las opps de Venta nunca se resuelven por
-- esta vía (la app solo escribe estas columnas para Post-venta en
-- "Caso problemático"). No se añade CHECK para no acoplar al nombre de la
-- etapa (editable por admin); la regla vive en la capa de servicio.
--
-- NULL-handling: una opp con resolved_at NULL es activa por default; los
-- queries del pipeline activo excluyen `resolved_at IS NOT NULL`.
-- ============================================================

alter table public.opportunities
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by_user_id uuid
    references public.user_profiles(id) on delete set null,
  add column if not exists resolution_note text;

-- Índice parcial para la vista "Casos resueltos" (conjunto chico —
-- los resueltos son minoría). Las vistas activas filtran por
-- `resolved_at IS NULL`, que es la mayoría y no necesita índice dedicado.
create index if not exists opportunities_org_resolved_idx
  on public.opportunities (organization_id, resolved_at)
  where resolved_at is not null;

comment on column public.opportunities.resolved_at is
  'Cierre de Caso problemático (M3v2). NULL=abierto; IS NOT NULL=resuelto+archivado. La etapa se preserva.';
