-- ============================================================
-- M1v2 · 0029 — Reglas de automatización V2: acciones permitidas
-- ============================================================
-- En V2 una regla SOLO puede crear tarea + avisar (create_task,
-- notify_advisor, notify_admin). Las acciones que MODIFICAN la
-- oportunidad quedan deliberadamente fuera por riesgo (decisión del
-- operador, M1v2): move_to_stage, add_tag y cualquier assign_*.
--
-- Esta migración:
--   1) Agrega `tasks.created_by_rule_id` — procedencia de la tarea
--      generada por una regla. Habilita la idempotencia R4 (no
--      duplicar tarea mientras haya una abierta de la misma regla) y
--      que Mi Día muestre "generada por regla" como motivo.
--   2) Depura las filas EXISTENTES de automation_rules: elimina de su
--      array `actions` todo elemento con type prohibido en V2. La regla
--      semilla "Cliente entregado hace 7 días" pierde su move_to_stage
--      y conserva su create_task.
--   3) Re-CREATE de `bootstrap_organization` — copia FIEL de la versión
--      vigente (0019) con el ÚNICO cambio de quitar el move_to_stage de
--      esa regla, para que las ORGS FUTURAS nazcan 100% conformes a V2.
--      (Patrón canónico del proyecto — ver 0027: re-CREATE fiel sobre la
--      versión vigente, nunca rebasándose en una vieja.)
--
-- El motor (lib/services/rules-engine.ts) además RECHAZA en ejecución
-- cualquier acción prohibida (defensa en profundidad): aunque una regla
-- llegara a tener una, nunca se ejecuta.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Procedencia de tarea generada por regla
-- ------------------------------------------------------------
alter table public.tasks
  add column if not exists created_by_rule_id uuid
    references public.automation_rules(id) on delete set null;

create index if not exists tasks_created_by_rule_open_idx
  on public.tasks (created_by_rule_id, opportunity_id)
  where created_by_rule_id is not null and status in ('pending', 'snoozed');

-- ------------------------------------------------------------
-- 2) Depurar acciones prohibidas de las reglas existentes
-- ------------------------------------------------------------
update public.automation_rules
   set actions = coalesce(
         (select jsonb_agg(elem)
            from jsonb_array_elements(actions) elem
           where elem->>'type' not in (
             'move_to_stage', 'add_tag', 'assign_to_advisor', 'assign_to_vendor', 'assign'
           )),
         '[]'::jsonb)
 where exists (
   select 1
     from jsonb_array_elements(actions) elem
    where elem->>'type' in (
      'move_to_stage', 'add_tag', 'assign_to_advisor', 'assign_to_vendor', 'assign'
    )
 );

-- ------------------------------------------------------------
-- 3) bootstrap_organization — re-CREATE fiel de 0019 sin move_to_stage
-- ------------------------------------------------------------
-- CONTRATO DE INVARIANTES (toda redefinición futura debe conservarlos):
--   (A) 9 etapas Funnel Venta v5.1 con Lead nuevo inicial.
--   (B) 7 etapas Funnel Post-venta V1 con Cotización completada inicial.
--   (C) usuario sistema Histórico (tokens auth en '' los inicializa GoTrue;
--       aquí se siembra por SQL crudo igual que 0019 — ver 0028/ERRORES).
--   (D) 6 reglas pre-cargadas (4 activas + 2 inactivas), TODAS con acciones
--       conformes a V2 (solo create_task / notify_advisor / notify_admin).
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

  -- 4) Etapas Funnel Post-venta — V1 (7 etapas, M7.2)
  insert into public.pipeline_stages
    (organization_id, funnel, name, position, color, is_initial)
  values
    (v_org_id, 'post_venta', 'Cotización completada',    1, '#34D399', true),
    (v_org_id, 'post_venta', 'Pago confirmado',          2, '#22C55E', false),
    (v_org_id, 'post_venta', 'Envío en curso',           3, '#60A5FA', false),
    (v_org_id, 'post_venta', 'Entregado',                4, '#10B981', false),
    (v_org_id, 'post_venta', 'Seguimiento post-entrega', 5, '#FBBF24', false),
    (v_org_id, 'post_venta', 'Cliente activo',           6, '#22D3EE', false),
    (v_org_id, 'post_venta', 'Caso problemático',        7, '#EF4444', false);

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
    (v_org_id, 'post_venta', 'Cliente activo sin recompra 90 días', false, true,
      'no_activity',
      jsonb_build_object('days_without_activity', 90, 'restricted_to_stage', 'Cliente activo'),
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
