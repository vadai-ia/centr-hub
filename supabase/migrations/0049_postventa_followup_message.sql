-- ============================================================
-- Mensajes de Post-venta: sellos de envío · 0049
-- ============================================================
-- Los dos mensajes al cliente tras la entrega salen de instancias
-- DISTINTAS de Whaapy y en momentos distintos:
--
--   mensaje 1 — confirmación de entrega, desde el número de VENTAS,
--               al entrar la opp a "Entregado".
--   mensaje 2 — seguimiento ("7 dias"), desde el número de POST-VENTA,
--               7 días DESPUÉS de que salió el mensaje 1.
--
-- El ancla del temporizador es el ENVÍO del primero, no la entrega: es el
-- instante que la plataforma controla y puede sellar con exactitud.
--
-- Por qué columnas y no derivarlo del audit_log: el cron necesita un
-- predicado indexable ("ya salió el 1 y no ha salido el 2") y, sobre todo,
-- IDEMPOTENCIA DURA. El mensaje 2 es de categoría MARKETING — mandárselo
-- dos veces al mismo cliente es peor que no mandarlo. Con estas columnas
-- el "ya se envió" es un hecho en la fila, no una búsqueda en un log
-- append-only que podría leerse a destiempo entre reintentos.
-- ============================================================

ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS delivery_message_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS followup_message_sent_at timestamptz;

COMMENT ON COLUMN public.opportunities.delivery_message_sent_at IS
  'Cuándo la plataforma disparó el mensaje 1 (confirmación de entrega, '
  'Whaapy de VENTA). NULL = no se ha enviado. Es el ANCLA del temporizador '
  'de 7 días del mensaje 2 — no la fecha de entrega.';

COMMENT ON COLUMN public.opportunities.followup_message_sent_at IS
  'Cuándo la plataforma disparó el mensaje 2 (seguimiento "7 dias", Whaapy '
  'de POST-VENTA). NULL = pendiente. Es el candado de idempotencia: el cron '
  'solo toma filas con este campo en NULL, así un reintento no le manda al '
  'cliente un segundo mensaje de marketing.';

-- Índice del cron: "listas para el mensaje 2". Parcial — solo las filas
-- que el cron puede tomar, que son una fracción mínima de la tabla.
CREATE INDEX IF NOT EXISTS opportunities_followup_pending_idx
  ON public.opportunities (organization_id, delivery_message_sent_at)
  WHERE delivery_message_sent_at IS NOT NULL
    AND followup_message_sent_at IS NULL
    AND cancelled_at IS NULL;

COMMENT ON INDEX public.opportunities_followup_pending_idx IS
  'Cron del mensaje 2 (0049): opps con el mensaje 1 ya enviado y el 2 '
  'pendiente. Parcial para que no crezca con el histórico ya notificado.';
