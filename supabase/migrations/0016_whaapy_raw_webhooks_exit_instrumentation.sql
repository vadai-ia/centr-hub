-- ============================================================
-- M4 DEBUG · 0016 — Instrumentación de exit paths del endpoint Whaapy
-- ============================================================
-- Extensión de la tabla raw introducida en 0015. Se agrega:
--
--   - `endpoint text` — diferencia filas escritas por
--     /api/webhooks/whaapy ('productive') vs filas escritas por
--     /api/webhooks/whaapy-raw (NULL — el sink raw no setea esta
--     columna). Permite filtrar "qué requests llegaron al productivo".
--
--   - `exit_reason text` — identifica el path por el que el endpoint
--     productivo retornó la respuesta. Valores esperados:
--       'missing_signature', 'invalid_json', 'missing_business_id',
--       'organization_not_found', 'missing_secret', 'invalid_hmac',
--       'unknown_topic', 'dedup_hit', 'unhandled_topic',
--       'enqueue_failed', 'enqueue_succeeded'.
--     NULL indica que la fila se insertó pero el endpoint no pudo
--     llegar al UPDATE final (excepción no capturada, timeout, etc).
--     Esa observabilidad de "insert sin tag" es señal diagnóstica
--     válida.
--
-- Índice parcial sobre filas tagueadas para que la consulta de
-- diagnóstico no escanee la tabla entera (que también incluye filas
-- del endpoint raw paralelo).
-- ============================================================

alter table public.whaapy_raw_webhooks
  add column if not exists endpoint text;

alter table public.whaapy_raw_webhooks
  add column if not exists exit_reason text;

create index if not exists whaapy_raw_webhooks_exit_reason_idx
  on public.whaapy_raw_webhooks (received_at desc, exit_reason)
  where endpoint = 'productive';
