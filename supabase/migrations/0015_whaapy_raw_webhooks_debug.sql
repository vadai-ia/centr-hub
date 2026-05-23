-- ============================================================
-- M4 DEBUG · 0015 — Tabla raw paralela para diagnóstico de webhooks Whaapy
-- ============================================================
-- Endpoint /api/webhooks/whaapy persistentemente no muestra rastro
-- en audit_log a pesar de Vercel logs confirmando recepción y 200 OK.
-- Bypass total: endpoint /api/webhooks/whaapy-raw que guarda crudos
-- aquí sin Zod / HMAC / dedup / Inngest / tenant resolution.
--
-- Tabla intencionalmente fuera del modelo multi-tenant:
--   - SIN organization_id (no resolvemos tenant en el bypass).
--   - SIN RLS (acceso libre vía service_role).
--   - SIN FK (independiente de cualquier otra tabla).
--   - SIN trigger (no participamos en updated_at de mantenimiento).
--
-- Sirve UNA función: confirmar si las requests de Whaapy realmente
-- llegan al runtime y persisten en BD. Una vez resuelto el bug del
-- endpoint principal, esta tabla queda como herramienta de
-- diagnóstico futura o se elimina en milestone posterior.
-- ============================================================

create table if not exists public.whaapy_raw_webhooks (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  headers jsonb,
  body jsonb,
  raw_body text
);
