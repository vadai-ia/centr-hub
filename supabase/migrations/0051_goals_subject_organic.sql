-- ============================================================
-- Metas · 0051 — El SUJETO de una meta se vuelve explícito (+ venta orgánica)
-- ============================================================
-- Hasta ahora el sujeto de una meta se INFERÍA de una columna nullable:
-- `advisor_membership_id IS NULL` significaba "meta de equipo". Ese truco
-- alcanza para dos sujetos y se rompe con el tercero.
--
-- El tercero es la VENTA ORGÁNICA: la que entra sola por la tienda online,
-- sin vendedor. La dirección reparte la meta mensual en cubetas —"de los 7
-- millones, 1 es orgánico y el resto se divide entre los vendedores"— y sin
-- poder expresar esa cubeta el tablero no cuadra contra la meta total.
--
-- `subject` lo dice de frente: 'team' | 'advisor' | 'organic'. La columna
-- nullable deja de cargar semántica implícita.
--
-- QUÉ ES "ORGÁNICA", MEDIDO EN DATOS REALES: Shopify marca el origen de cada
-- pedido en `source_name`, que la plataforma persiste en `orders.source`. En
-- Centr solo aparecen dos valores: 'web' (tienda online) y
-- 'shopify_draft_order' (cotización creada por un vendedor).
--
-- ORGÁNICA NO ES "SIN ASESOR ASIGNADO", y la diferencia es enorme: de 947
-- pedidos, 578 no tienen asesor, pero solo 287 de esos son 'web' — los otros
-- 291 son draft orders donde el vendedor no puso su etiqueta. Usar "sin
-- asesor" como criterio metería esa venta en la cubeta orgánica e inflaría el
-- canal a costa de las metas individuales. El criterio es `source`, no la
-- ausencia de asesor.
--
-- MÉTRICA ÚNICA PARA ORGÁNICA: solo 'amount' (monto vendido). Una venta
-- orgánica no tiene cotización enviada ni oportunidad trabajada, así que
-- 'quotes' y 'won' no tendrían significado — se rechazan por CHECK en vez de
-- dejar que alguien cree una meta que siempre marcaría cero.

-- ------------------------------------------------------------
-- 1. Columna + backfill (sin cambio de comportamiento)
-- ------------------------------------------------------------
ALTER TABLE public.goals
  ADD COLUMN IF NOT EXISTS subject text NOT NULL DEFAULT 'advisor';

UPDATE public.goals
   SET subject = CASE WHEN advisor_membership_id IS NULL THEN 'team' ELSE 'advisor' END
 WHERE subject NOT IN ('team', 'organic');

COMMENT ON COLUMN public.goals.subject IS
  'Sujeto de la meta (0051): team = toda la organización; advisor = un '
  'vendedor (requiere advisor_membership_id); organic = venta de la tienda '
  'online (orders.source = ''web''), sin vendedor. Sustituye a la inferencia '
  'por advisor_membership_id IS NULL.';

-- ------------------------------------------------------------
-- 2. Invariantes del sujeto
-- ------------------------------------------------------------
ALTER TABLE public.goals
  DROP CONSTRAINT IF EXISTS goals_subject_valid,
  DROP CONSTRAINT IF EXISTS goals_subject_advisor_shape,
  DROP CONSTRAINT IF EXISTS goals_organic_amount_only;

ALTER TABLE public.goals
  ADD CONSTRAINT goals_subject_valid
    CHECK (subject IN ('team', 'advisor', 'organic')),
  -- Un sujeto 'advisor' SIEMPRE apunta a alguien; los otros dos NUNCA.
  ADD CONSTRAINT goals_subject_advisor_shape
    CHECK (
      (subject = 'advisor' AND advisor_membership_id IS NOT NULL)
      OR (subject IN ('team', 'organic') AND advisor_membership_id IS NULL)
    ),
  -- La venta orgánica solo se mide en monto (ver cabecera).
  ADD CONSTRAINT goals_organic_amount_only
    CHECK (subject <> 'organic' OR metric = 'amount');

-- ------------------------------------------------------------
-- 3. Unicidad por sujeto
-- ------------------------------------------------------------
-- El índice viejo de equipo cubría "advisor_membership_id IS NULL", que ahora
-- abarca DOS sujetos distintos (team y organic) — sin reemplazarlo, la meta
-- orgánica de monto chocaría con la de equipo del mismo monto.
DROP INDEX IF EXISTS public.goals_org_team_metric_uniq;
DROP INDEX IF EXISTS public.goals_org_advisor_metric_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS goals_org_advisor_metric_uniq
  ON public.goals (organization_id, advisor_membership_id, metric)
  WHERE subject = 'advisor';

CREATE UNIQUE INDEX IF NOT EXISTS goals_org_team_metric_uniq
  ON public.goals (organization_id, metric)
  WHERE subject = 'team';

CREATE UNIQUE INDEX IF NOT EXISTS goals_org_organic_metric_uniq
  ON public.goals (organization_id, metric)
  WHERE subject = 'organic';

-- ------------------------------------------------------------
-- 4. El histórico también necesita el sujeto
-- ------------------------------------------------------------
-- `goal_results` (snapshot mensual, append-only) heredaba la misma inferencia:
-- su índice único de equipo es (org, metric, month) WHERE advisor IS NULL.
-- Con una meta de equipo Y una orgánica del mismo monto, el cron intentaría
-- insertar DOS filas que caen en ese índice y el snapshot del mes entero
-- fallaría por violación de unicidad. Además, sin `subject` las dos quedarían
-- indistinguibles en el histórico ("Equipo" para ambas).
ALTER TABLE public.goal_results
  ADD COLUMN IF NOT EXISTS subject text NOT NULL DEFAULT 'advisor';

UPDATE public.goal_results
   SET subject = CASE WHEN advisor_membership_id IS NULL THEN 'team' ELSE 'advisor' END
 WHERE subject NOT IN ('team', 'organic');

ALTER TABLE public.goal_results
  DROP CONSTRAINT IF EXISTS goal_results_subject_valid;
ALTER TABLE public.goal_results
  ADD CONSTRAINT goal_results_subject_valid
    CHECK (subject IN ('team', 'advisor', 'organic'));

COMMENT ON COLUMN public.goal_results.subject IS
  'Sujeto de la meta congelada (0051), espejo de goals.subject. Necesario '
  'para distinguir el resultado de equipo del de venta orgánica: ambos van '
  'con advisor_membership_id NULL.';

DROP INDEX IF EXISTS public.goal_results_org_team_metric_month_uniq;
DROP INDEX IF EXISTS public.goal_results_org_advisor_metric_month_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS goal_results_org_advisor_metric_month_uniq
  ON public.goal_results (organization_id, advisor_membership_id, metric, period_month)
  WHERE subject = 'advisor';

CREATE UNIQUE INDEX IF NOT EXISTS goal_results_org_team_metric_month_uniq
  ON public.goal_results (organization_id, metric, period_month)
  WHERE subject = 'team';

CREATE UNIQUE INDEX IF NOT EXISTS goal_results_org_organic_metric_month_uniq
  ON public.goal_results (organization_id, metric, period_month)
  WHERE subject = 'organic';
