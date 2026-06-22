-- ============================================================
-- Post-venta · 0033 — "Caso cerrado": cierre normal terminal archivable (M4v2)
-- ============================================================
-- El Funnel Post-venta no tenía una etapa terminal de CIERRE NORMAL (la
-- venta que terminó bien: el pedido llegó al cliente y todo correcto).
-- M4v2 la introduce RENOMBRANDO la etapa existente "Cliente activo"
-- (posición 6) a "Caso cerrado" y marcándola terminal.
--
-- DECISIÓN DE DISEÑO — `is_won = true` (reuso del mecanismo existente):
--   Para que "Caso cerrado" se archive EXACTAMENTE como Ganada/Perdida
--   (auto-ocultar tras N días + "Ver cerradas"), reusa la maquinaria de
--   cierre ya existente: `pipeline-move` setea `won_at` al entrar a una
--   etapa `is_won` (lib/services/pipeline-move.ts), `partitionClosedStages`
--   /`closedFilterForStage` la reconocen por el flag, y el kanban la oculta
--   por `won_at`. NO se crea un timer ni un camino de archivado paralelo
--   (requisito M4v2).
--
--   CAVEAT SEMÁNTICO (documentado para que el flag no sea trampa futura):
--   "is_won" nominalmente significa "venta ganada", y un cierre de
--   Post-venta NO es una venta. Se reusa el flag SOLO porque está
--   PROBADO que ningún consumidor de Venta puede contaminarse:
--     · Win-rate / Cotizaciones / Ganadas / Pipeline$ / metas
--       (lib/db/dashboard.ts, tallyAchievement) filtran funnel='venta' en
--       SQL — un is_won de Post-venta queda fuera del fetch.
--     · Fronteras de etapa (dashboard-stages.resolveVentaStageBoundaries)
--       buscan wonStage SOLO dentro de listPipelineStages("venta").
--     · Motor de reglas cruza terminalStageIds contra opps ya acotadas a
--       rule.funnel.
--     · partitionClosedStages recibe las etapas del funnel cargado (uno a
--       la vez en el kanban).
--   Donde is_won SÍ cambia algo en Post-venta, el cambio es el DESEADO:
--   KPI "Post-venta vivos" excluye cerrados; el conteo de opps activas por
--   asesor (users.ts) no cuenta cerrados como pendientes; el kanban auto-
--   oculta. La UI muestra el NOMBRE "Caso cerrado", nunca "Ganada"
--   (no hay badge de is_won en el card). Ver ERRORES.md
--   ("is_won reusado en Post-venta 'Caso cerrado'").
--
-- No hay constraint de unicidad sobre is_won por funnel (solo is_initial,
-- 0004), así que marcar la primera terminal de Post-venta es seguro.
--
-- Renombrar IN SITU (patrón 0019): preserva el `id` y por ende TODAS las
-- opps que apuntan a esa etapa (opportunities.stage_id ... on delete
-- restrict) y su historial. NO borrar+crear.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Renombrar + flag terminal en orgs existentes (Centr/Rustr)
-- ------------------------------------------------------------
-- Match por (funnel, name) → aplica a TODAS las orgs que tengan la etapa
-- semilla "Cliente activo". Color nuevo (teal-600) distinto del resto del
-- catálogo Post-venta para leer como cierre normal/positivo.
update public.pipeline_stages
   set name    = 'Caso cerrado',
       is_won  = true,
       color   = '#0D9488'
 where funnel = 'post_venta'
   and name   = 'Cliente activo';

-- ------------------------------------------------------------
-- 2) Re-anclar la regla seed huérfana tras el rename
-- ------------------------------------------------------------
-- La regla (inactiva, template) "Cliente activo sin recompra 90 días"
-- anclaba por NOMBRE a 'Cliente activo' (rules-engine la matchea por
-- restricted_to_stage). Tras el rename ese ancla queda colgado → se
-- re-apunta a 'Caso cerrado' y se renombra para mantener el seed coherente
-- (patrón "reconciliación de seeds", ERRORES.md). Sigue inactiva.
update public.automation_rules
   set name           = 'Caso cerrado sin recompra 90 días',
       trigger_config = jsonb_set(
         trigger_config,
         '{restricted_to_stage}',
         to_jsonb('Caso cerrado'::text)
       )
 where funnel = 'post_venta'
   and trigger_type = 'no_activity'
   and trigger_config->>'restricted_to_stage' = 'Cliente activo';

-- ------------------------------------------------------------
-- 3) bootstrap_organization — re-CREATE fiel de 0030 con el delta
-- ------------------------------------------------------------
-- CONTRATO DE INVARIANTES (igual que 0030): 9 etapas Venta, 7 Post-venta,
-- usuario Histórico, 6 reglas pre-cargadas. Deltas vs 0030:
--   (a) Post-venta etapa 6: "Cliente activo" → "Caso cerrado", is_won=true,
--       color teal-600. (Se agrega is_won a la lista de columnas del INSERT
--       de Post-venta, que en 0030 no lo declaraba — default false para el
--       resto.)
--   (b) Regla seed "Cliente activo sin recompra 90 días" →
--       "Caso cerrado sin recompra 90 días", restricted_to_stage='Caso cerrado'.
create or replace function public.bootstrap_organization(
  p_name              text,
  p_slug              citext,
  p_shopify_store_url text default null,
  p_shopify_domain    text default null,
  p_whaapy_business   text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_org_id         uuid;
  v_historic_uid   uuid;
  v_historic_email citext;
begin
  -- 1) Organización
  insert into public.organizations
    (name, slug, shopify_store_url, shopify_store_domain, whaapy_business_id)
  values
    (p_name, p_slug, p_shopify_store_url, p_shopify_domain, p_whaapy_business)
  returning id into v_org_id;

  -- 2) Usuario sistema "Histórico" (O10 + R10)
  v_historic_uid   := gen_random_uuid();
  v_historic_email := ('historico@' || p_slug || '.centrhub.local')::citext;

  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous
  )
  values (
    v_historic_uid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated',
    'authenticated',
    v_historic_email::text,
    '',
    now(),
    now(),
    now(),
    jsonb_build_object('provider', 'system', 'is_system_user', true),
    jsonb_build_object('full_name', 'Histórico'),
    false,
    false
  );

  insert into public.user_profiles (id, full_name, color, is_system_user)
  values (v_historic_uid, 'Histórico', '#9CA3AF', true);

  insert into public.memberships (user_id, organization_id, role, is_active)
  values (v_historic_uid, v_org_id, 'vendedor', false);

  -- 3) Etapas Funnel Venta — v5.1 (9 etapas, doctrina §3.3.9)
  insert into public.pipeline_stages
    (organization_id, funnel, name, position, color, default_probability,
     is_initial, is_won, is_lost, requires_loss_reason)
  values
    (v_org_id, 'venta', 'Lead nuevo',              1, '#9CA3AF',  10.00, true,  false, false, false),
    (v_org_id, 'venta', 'Contactado asesor',       2, '#60A5FA',  20.00, false, false, false, false),
    (v_org_id, 'venta', 'Contacto calificado',     3, '#3B82F6',  30.00, false, false, false, false),
    (v_org_id, 'venta', 'Reunión agendada',        4, '#6366F1',  45.00, false, false, false, false),
    (v_org_id, 'venta', 'Diseño de espacios',      5, '#8B5CF6',  55.00, false, false, false, false),
    (v_org_id, 'venta', 'Cotización',              6, '#34D399',  70.00, false, false, false, false),
    (v_org_id, 'venta', 'Seguimiento para cierre', 7, '#FBBF24',  85.00, false, false, false, false),
    (v_org_id, 'venta', 'Ganada',                  8, '#10B981', 100.00, false, true,  false, false),
    (v_org_id, 'venta', 'Perdida',                 9, '#EF4444',   0.00, false, false, true,  true);

  -- 4) Etapas Funnel Post-venta — V1 + M4v2 "Caso cerrado" terminal
  --    (etapa 6 renombrada de "Cliente activo" a "Caso cerrado", is_won).
  insert into public.pipeline_stages
    (organization_id, funnel, name, position, color, is_initial, is_won)
  values
    (v_org_id, 'post_venta', 'Cotización completada',    1, '#34D399', true,  false),
    (v_org_id, 'post_venta', 'Pago confirmado',          2, '#22C55E', false, false),
    (v_org_id, 'post_venta', 'Envío en curso',           3, '#60A5FA', false, false),
    (v_org_id, 'post_venta', 'Entregado',                4, '#10B981', false, false),
    (v_org_id, 'post_venta', 'Seguimiento post-entrega', 5, '#FBBF24', false, false),
    (v_org_id, 'post_venta', 'Caso cerrado',             6, '#0D9488', false, true),
    (v_org_id, 'post_venta', 'Caso problemático',        7, '#EF4444', false, false);

  -- 5) Motivos de pérdida (sin cambios)
  insert into public.loss_reasons (organization_id, name) values
    (v_org_id, 'Precio'),
    (v_org_id, 'Tiempo'),
    (v_org_id, 'Competencia'),
    (v_org_id, 'Ghosting (sin respuesta del cliente)'),
    (v_org_id, 'No era buen fit'),
    (v_org_id, 'Otro');

  -- 6) Reglas pre-cargadas — 4 activas + 2 inactivas (v5.1, acciones V2)
  insert into public.automation_rules
    (organization_id, funnel, name, is_active, is_template, trigger_type, trigger_config, conditions, actions)
  values
    (v_org_id, 'venta', 'Cotización sin respuesta 24h', true, true,
      'stage_aging',
      jsonb_build_object('stage_name', 'Cotización', 'hours_in_stage', 24),
      jsonb_build_array(jsonb_build_object('field', 'no_activity_hours', 'op', 'gte', 'value', 24)),
      jsonb_build_array(jsonb_build_object('type', 'create_task', 'task_type', 'follow_up', 'title', 'Hacer seguimiento'))),

    (v_org_id, 'venta', 'Oportunidad estancada 72h', true, true,
      'no_activity',
      jsonb_build_object('hours_without_activity', 72, 'exclude_terminal_stages', true),
      jsonb_build_array(),
      jsonb_build_array(
        jsonb_build_object('type', 'create_task', 'task_type', 'follow_up', 'title', 'Dar seguimiento a oportunidad estancada'),
        jsonb_build_object('type', 'notify_advisor'),
        jsonb_build_object('type', 'notify_admin')
      )),

    (v_org_id, 'venta', 'Seguimiento para cierre tardío', true, true,
      'stage_aging',
      jsonb_build_object('stage_name', 'Seguimiento para cierre', 'days_in_stage', 7),
      jsonb_build_array(),
      jsonb_build_array(jsonb_build_object('type', 'notify_admin'))),

    (v_org_id, 'post_venta', 'Cliente entregado hace 7 días', true, true,
      'stage_aging',
      jsonb_build_object('stage_name', 'Entregado', 'days_in_stage', 7),
      jsonb_build_array(),
      jsonb_build_array(
        jsonb_build_object('type', 'create_task', 'task_type', 'follow_up', 'title', 'Contactar cliente para seguimiento')
      ));

  insert into public.automation_rules
    (organization_id, funnel, name, is_active, is_template, trigger_type, trigger_config, conditions, actions)
  values
    (v_org_id, 'post_venta', 'Caso cerrado sin recompra 90 días', false, true,
      'no_activity',
      jsonb_build_object('days_without_activity', 90, 'restricted_to_stage', 'Caso cerrado'),
      jsonb_build_array(),
      jsonb_build_array(jsonb_build_object('type', 'create_task', 'task_type', 'follow_up', 'title', 'Re-contacto'))),

    (v_org_id, 'post_venta', 'Caso problemático abierto >48h', false, true,
      'stage_aging',
      jsonb_build_object('stage_name', 'Caso problemático', 'hours_in_stage', 48),
      jsonb_build_array(),
      jsonb_build_array(jsonb_build_object('type', 'notify_admin')));

  return v_org_id;
end;
$$;

revoke execute on function public.bootstrap_organization(text, citext, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.bootstrap_organization(text, citext, text, text, text)
  to service_role;
