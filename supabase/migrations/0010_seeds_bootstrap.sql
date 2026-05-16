-- ============================================================
-- M1 · 0010 — Bootstrap de organización (seeds iniciales)
-- ============================================================
-- Función SECURITY DEFINER que crea una organización con todos
-- sus seeds según Sección 3.3.9 del Master Document:
--   - 7 etapas Funnel Venta + 6 etapas Funnel Post-venta
--   - 6 motivos de pérdida
--   - 4 reglas core activas + 2 opcionales inactivas
--   - umbrales (default ya en organizations.config)
--   - usuario sistema "Histórico" + membresía desactivada
--
-- Fuente de verdad: Sección 3.3.9. Si hay discrepancia con el
-- prompt del milestone, gana el Master Document.
-- ============================================================

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
  v_org_id        uuid;
  v_historic_uid  uuid;
  v_historic_email citext;

  v_stage_lead_nuevo        uuid;
  v_stage_calificado        uuid;
  v_stage_cotizacion        uuid;
  v_stage_negociacion       uuid;
  v_stage_esperando_pago    uuid;
  v_stage_ganada            uuid;
  v_stage_perdida           uuid;

  v_stage_pago_confirmado   uuid;
  v_stage_preparacion       uuid;
  v_stage_entregado         uuid;
  v_stage_seguimiento       uuid;
  v_stage_cliente_activo    uuid;
  v_stage_caso_problematico uuid;
begin
  -- ------------------------------------------------------------
  -- 1) Crear organización
  -- ------------------------------------------------------------
  insert into public.organizations (name, slug, shopify_store_url, shopify_store_domain, whaapy_business_id)
  values (p_name, p_slug, p_shopify_store_url, p_shopify_domain, p_whaapy_business)
  returning id into v_org_id;

  -- ------------------------------------------------------------
  -- 2) Usuario sistema "Histórico" (O10 + R10)
  -- ------------------------------------------------------------
  v_historic_uid := gen_random_uuid();
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
    '',                                       -- sin password (no login)
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
  values (v_historic_uid, v_org_id, 'vendedor', false);   -- desactivada (R10)

  -- ------------------------------------------------------------
  -- 3) Etapas Funnel Venta
  -- ------------------------------------------------------------
  insert into public.pipeline_stages
    (organization_id, funnel, name, position, color, default_probability,
     is_initial, is_won, is_lost, requires_loss_reason)
  values
    (v_org_id, 'venta', 'Lead nuevo',         1, '#9CA3AF',  10.00, true,  false, false, false),
    (v_org_id, 'venta', 'Calificado',         2, '#60A5FA',  25.00, false, false, false, false),
    (v_org_id, 'venta', 'Cotización enviada', 3, '#34D399',  40.00, false, false, false, false),
    (v_org_id, 'venta', 'En negociación',     4, '#FBBF24',  60.00, false, false, false, false),
    (v_org_id, 'venta', 'Esperando pago',     5, '#F97316',  85.00, false, false, false, false),
    (v_org_id, 'venta', 'Ganada',             6, '#10B981', 100.00, false, true,  false, false),
    (v_org_id, 'venta', 'Perdida',            7, '#EF4444',   0.00, false, false, true,  true)
  returning id into v_stage_lead_nuevo;   -- captura la primera (no la usamos directo)

  -- recuperar IDs explícitos por nombre para usarlos en seeds posteriores
  select id into v_stage_lead_nuevo
    from public.pipeline_stages
    where organization_id = v_org_id and funnel = 'venta' and name = 'Lead nuevo';

  select id into v_stage_calificado
    from public.pipeline_stages
    where organization_id = v_org_id and funnel = 'venta' and name = 'Calificado';

  select id into v_stage_cotizacion
    from public.pipeline_stages
    where organization_id = v_org_id and funnel = 'venta' and name = 'Cotización enviada';

  select id into v_stage_negociacion
    from public.pipeline_stages
    where organization_id = v_org_id and funnel = 'venta' and name = 'En negociación';

  select id into v_stage_esperando_pago
    from public.pipeline_stages
    where organization_id = v_org_id and funnel = 'venta' and name = 'Esperando pago';

  select id into v_stage_ganada
    from public.pipeline_stages
    where organization_id = v_org_id and funnel = 'venta' and name = 'Ganada';

  select id into v_stage_perdida
    from public.pipeline_stages
    where organization_id = v_org_id and funnel = 'venta' and name = 'Perdida';

  -- ------------------------------------------------------------
  -- 4) Etapas Funnel Post-venta
  -- ------------------------------------------------------------
  insert into public.pipeline_stages
    (organization_id, funnel, name, position, color, is_initial)
  values
    (v_org_id, 'post_venta', 'Pago confirmado',          1, '#34D399', true),
    (v_org_id, 'post_venta', 'Preparación / Envío',      2, '#60A5FA', false),
    (v_org_id, 'post_venta', 'Entregado',                3, '#10B981', false),
    (v_org_id, 'post_venta', 'Seguimiento post-entrega', 4, '#FBBF24', false),
    (v_org_id, 'post_venta', 'Cliente activo',           5, '#22D3EE', false),
    (v_org_id, 'post_venta', 'Caso problemático',        6, '#EF4444', false);

  select id into v_stage_pago_confirmado
    from public.pipeline_stages
    where organization_id = v_org_id and funnel = 'post_venta' and name = 'Pago confirmado';
  select id into v_stage_preparacion
    from public.pipeline_stages
    where organization_id = v_org_id and funnel = 'post_venta' and name = 'Preparación / Envío';
  select id into v_stage_entregado
    from public.pipeline_stages
    where organization_id = v_org_id and funnel = 'post_venta' and name = 'Entregado';
  select id into v_stage_seguimiento
    from public.pipeline_stages
    where organization_id = v_org_id and funnel = 'post_venta' and name = 'Seguimiento post-entrega';
  select id into v_stage_cliente_activo
    from public.pipeline_stages
    where organization_id = v_org_id and funnel = 'post_venta' and name = 'Cliente activo';
  select id into v_stage_caso_problematico
    from public.pipeline_stages
    where organization_id = v_org_id and funnel = 'post_venta' and name = 'Caso problemático';

  -- ------------------------------------------------------------
  -- 5) Motivos de pérdida
  -- ------------------------------------------------------------
  insert into public.loss_reasons (organization_id, name) values
    (v_org_id, 'Precio'),
    (v_org_id, 'Tiempo'),
    (v_org_id, 'Competencia'),
    (v_org_id, 'Ghosting (sin respuesta del cliente)'),
    (v_org_id, 'No era buen fit'),
    (v_org_id, 'Otro');

  -- ------------------------------------------------------------
  -- 6) Reglas pre-cargadas (4 activas + 2 inactivas)
  -- ------------------------------------------------------------
  -- Activas
  insert into public.automation_rules
    (organization_id, funnel, name, is_active, is_template, trigger_type, trigger_config, conditions, actions)
  values
    (v_org_id, 'venta', 'Cotización sin respuesta 24h', true, true,
      'stage_aging',
      jsonb_build_object('stage_name', 'Cotización enviada', 'hours_in_stage', 24),
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

    (v_org_id, 'venta', 'Esperando pago tardío', true, true,
      'stage_aging',
      jsonb_build_object('stage_name', 'Esperando pago', 'days_in_stage', 7),
      jsonb_build_array(),
      jsonb_build_array(jsonb_build_object('type', 'notify_admin'))),

    (v_org_id, 'post_venta', 'Cliente entregado hace 7 días', true, true,
      'stage_aging',
      jsonb_build_object('stage_name', 'Entregado', 'days_in_stage', 7),
      jsonb_build_array(),
      jsonb_build_array(
        jsonb_build_object('type', 'create_task', 'task_type', 'follow_up', 'title', 'Contactar cliente para seguimiento'),
        jsonb_build_object('type', 'move_to_stage', 'stage_name', 'Seguimiento post-entrega')
      ));

  -- Opcionales (inactivas — el admin las activa cuando lo decida)
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

revoke all on function public.bootstrap_organization(text, citext, text, text, text) from public;
grant execute on function public.bootstrap_organization(text, citext, text, text, text) to service_role;
