-- ============================================================
-- Metas · 0053 — % de cierre de cotizaciones como métrica de meta (OKR)
-- ============================================================
-- La dirección quiere medir no solo cuántas cotizaciones hace cada vendedor,
-- sino qué tan bien las cierra: "de 100 cotizaciones, ¿cuántas ganó?". Es un
-- porcentaje, y ninguna de las tres métricas existentes lo expresa:
--   quotes (cantidad) · won (cantidad) · amount (monto).
--
-- Se agrega `close_rate`, con estas reglas:
--
--  * DEFINICIÓN POR COHORTE: de las cotizaciones CREADAS en el mes, cuántas ya
--    se ganaron. NO es "ganadas del mes ÷ cotizaciones del mes": eso mezclaría
--    cierres de cotizaciones de meses anteriores y podría dar más de 100%.
--    Consecuencia a comunicar: en el mes en curso arranca bajo y sube conforme
--    esas cotizaciones cierran.
--  * EL OBJETIVO ES UN PORCENTAJE 0–100 (CHECK abajo). El avance de la meta
--    sigue siendo logrado ÷ objetivo: 24% de cierre contra una meta de 30% es
--    un 80% de cumplimiento.
--  * La venta orgánica NO la admite: su CHECK de 0051 (`goals_organic_amount_only`)
--    ya la restringe a `amount` y sigue vigente.
--
-- Los CHECK originales de `metric` (0031) se crearon inline, sin nombre
-- explícito. En vez de adivinar el nombre que les puso Postgres, se localizan
-- por su definición y se reemplazan por unos con nombre estable.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname, t.relname
      FROM pg_constraint c
      JOIN pg_class t     ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname IN ('goals', 'goal_results')
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%metric%'
       AND pg_get_constraintdef(c.oid) ILIKE '%quotes%'
       -- nunca tocar el invariante de orgánica de 0051
       AND pg_get_constraintdef(c.oid) NOT ILIKE '%organic%'
  LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.relname, r.conname);
  END LOOP;
END $$;

ALTER TABLE public.goals
  DROP CONSTRAINT IF EXISTS goals_close_rate_is_percent;

ALTER TABLE public.goals
  ADD CONSTRAINT goals_metric_valid
    CHECK (metric IN ('quotes', 'won', 'amount', 'close_rate')),
  -- El objetivo de un porcentaje no puede pasar de 100.
  ADD CONSTRAINT goals_close_rate_is_percent
    CHECK (metric <> 'close_rate' OR (target_value >= 0 AND target_value <= 100));

ALTER TABLE public.goal_results
  ADD CONSTRAINT goal_results_metric_valid
    CHECK (metric IN ('quotes', 'won', 'amount', 'close_rate'));

COMMENT ON COLUMN public.goals.metric IS
  'Qué se mide (0031, 0053): quotes = cotizaciones enviadas (cantidad); '
  'won = oportunidades ganadas (cantidad); amount = monto vendido; '
  'close_rate = % de cierre de cotizaciones, 0–100, por cohorte (de las '
  'cotizaciones creadas en el mes, cuántas ya se ganaron).';
