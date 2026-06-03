-- ============================================================
-- M7.2 · 0019 — Reconciliación seed Funnel Post-venta (6 → 7)
-- ============================================================
-- V1 redefine el Funnel Post-venta para soportar el trigger
-- atómico F1→F2 (Bloque 2): la oportunidad hija nace en una NUEVA
-- etapa inicial "Cotización completada" (no en "Pago confirmado").
--
-- Estado previo (migración 0013, 6 etapas):
--   1 Pago confirmado (is_initial)   2 Preparación / Envío
--   3 Entregado                      4 Seguimiento post-entrega
--   5 Cliente activo                 6 Caso problemático
--
-- Estado objetivo V1 (7 etapas):
--   1 Cotización completada (is_initial)  ← NUEVA
--   2 Pago confirmado                     ← pierde is_initial
--   3 Envío en curso                      ← rename de "Preparación / Envío"
--   4 Entregado
--   5 Seguimiento post-entrega
--   6 Cliente activo
--   7 Caso problemático
--
-- ESTRATEGIA DE RECONCILIACIÓN (sin romper oportunidades):
--   En vez de DELETE + CREATE de "Preparación / Envío" (que rompería
--   el FK `opportunities.stage_id ... on delete restrict` si hubiera
--   opps ahí), se RENOMBRA in situ a "Envío en curso" — preserva el
--   id de la etapa y por lo tanto todas las oportunidades que la
--   referencien. El resultado final son las 7 etapas objetivo con
--   cero pérdida de datos. La única etapa verdaderamente nueva es
--   "Cotización completada".
--
--   Orden crítico: se quita is_initial de "Pago confirmado" ANTES de
--   insertar "Cotización completada" con is_initial=true, para no
--   violar el índice único `pipeline_stages_one_initial_per_funnel_idx`.
--
-- Idempotente: si "Cotización completada" ya existe en post_venta de
-- la org, se asume migrada y se salta. Aplica a Centr/Rustr + futuro
-- bootstrap. El Funnel Venta y el resto del schema quedan intactos.
-- ============================================================

do $$
declare
  v_org_ids uuid[] := array[
    'a1edfbdf-b0a9-45db-a652-5241dc49b48b'::uuid,  -- Centr
    '7503aa44-e844-4376-a332-74daf7e50e9a'::uuid   -- Rustr
  ];
  v_org_id uuid;
begin
  foreach v_org_id in array v_org_ids
  loop
    if not exists (
      select 1 from public.organizations where id = v_org_id
    ) then
      continue;
    end if;

    -- Ya migrada: "Cotización completada" presente → saltar.
    if exists (
      select 1 from public.pipeline_stages
       where organization_id = v_org_id
         and funnel = 'post_venta'
         and name = 'Cotización completada'
    ) then
      continue;
    end if;

    -- 1) Rename "Preparación / Envío" → "Envío en curso" (preserva opps).
    update public.pipeline_stages
       set name = 'Envío en curso'
     where organization_id = v_org_id
       and funnel = 'post_venta'
       and name = 'Preparación / Envío';

    -- 2) Quitar is_initial de "Pago confirmado" (libera el índice único).
    update public.pipeline_stages
       set is_initial = false
     where organization_id = v_org_id
       and funnel = 'post_venta'
       and is_initial = true;

    -- 3) Insertar la nueva etapa inicial "Cotización completada".
    insert into public.pipeline_stages
      (organization_id, funnel, name, position, color, is_initial)
    values
      (v_org_id, 'post_venta', 'Cotización completada', 1, '#34D399', true);

    -- 4) Renormalizar posiciones al orden objetivo (por nombre).
    update public.pipeline_stages set position = 2
      where organization_id = v_org_id and funnel = 'post_venta' and name = 'Pago confirmado';
    update public.pipeline_stages set position = 3
      where organization_id = v_org_id and funnel = 'post_venta' and name = 'Envío en curso';
    update public.pipeline_stages set position = 4
      where organization_id = v_org_id and funnel = 'post_venta' and name = 'Entregado';
    update public.pipeline_stages set position = 5
      where organization_id = v_org_id and funnel = 'post_venta' and name = 'Seguimiento post-entrega';
    update public.pipeline_stages set position = 6
      where organization_id = v_org_id and funnel = 'post_venta' and name = 'Cliente activo';
    update public.pipeline_stages set position = 7
      where organization_id = v_org_id and funnel = 'post_venta' and name = 'Caso problemático';
  end loop;
end;
$$;


-- ============================================================
-- bootstrap_organization v5.1.1 — 7 etapas Post-venta en bootstrap
-- ============================================================
-- Idéntica a la versión de 0013 salvo el bloque de INSERT del Funnel
-- Post-venta, que ahora siembra las 7 etapas V1 con "Cotización
-- completada" como inicial. El resto (Funnel Venta 9 etapas, usuario
-- sistema Histórico, motivos, reglas pre-cargadas) no cambia.
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

  -- 6) Reglas pre-cargadas — 4 activas + 2 inactivas (v5.1)
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
        jsonb_build_object('type', 'create_task', 'task_type', 'follow_up', 'title', 'Contactar cliente para seguimiento'),
        jsonb_build_object('type', 'move_to_stage', 'stage_name', 'Seguimiento post-entrega')
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
