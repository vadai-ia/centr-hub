-- ============================================================
-- M2 · 0013 — Doctrina v5.1: Pipeline 9 etapas, clasificación
--             lead/cliente derivada y soporte auto-creación C2 (R12)
-- ============================================================
-- Tres cambios al schema, alineados con doctrina v5.1
-- (Secciones 3.3.3, 3.3.4, 3.3.9, 3.3.10 R12, 3.3.11 O12):
--
--   1. Reemplaza las 7 etapas Funnel Venta seeds por las 9
--      nuevas (Lead nuevo → Contactado asesor → Contacto
--      calificado → Reunión agendada → Diseño de espacios →
--      Cotización → Seguimiento para cierre → Ganada → Perdida).
--      Aplica a Centr/Rustr existentes y al bootstrap futuro.
--
--   2. Soporte de clasificación lead vs cliente derivada (O12):
--      columna calculada STORED `contact_type` en `contacts` —
--      'cliente' si tiene shopify_customer_id, 'lead' si no.
--
--   3. Soporte para auto-creación C2 (R12):
--        - `contacts.last_whaapy_activity_at` para evaluar
--          re-actividad después de N días.
--        - `organizations.c2_reactivity_threshold_days`
--          (default 30) override de N por organización.
--        - `organizations.backfill_in_progress` para suprimir
--          auto-creación durante backfill M11.
--
-- Funnel Post-venta (6 etapas), motivos de pérdida, usuario
-- sistema "Histórico" y RLS quedan intactos. Todas las
-- sentencias son idempotentes.
-- ============================================================


-- ============================================================
-- 1) contacts — clasificación derivada + actividad Whaapy
-- ============================================================

alter table public.contacts
  add column if not exists last_whaapy_activity_at timestamptz;

create index if not exists contacts_last_whaapy_activity_idx
  on public.contacts (organization_id, last_whaapy_activity_at desc)
  where last_whaapy_activity_at is not null;

-- contact_type (O12): derivado de shopify_customer_id.
-- STORED para indexabilidad y filtros sin recálculo por query.
alter table public.contacts
  add column if not exists contact_type text
    generated always as (
      case
        when shopify_customer_id is null then 'lead'
        else 'cliente'
      end
    ) stored;

create index if not exists contacts_contact_type_idx
  on public.contacts (organization_id, contact_type);


-- ============================================================
-- 2) organizations — overrides C2 + flag de backfill
-- ============================================================

alter table public.organizations
  add column if not exists c2_reactivity_threshold_days integer not null default 30;

alter table public.organizations
  add column if not exists backfill_in_progress boolean not null default false;

alter table public.organizations
  drop constraint if exists organizations_c2_reactivity_positive;
alter table public.organizations
  add constraint organizations_c2_reactivity_positive
    check (c2_reactivity_threshold_days > 0);


-- ============================================================
-- 3) Reemplazo de etapas Funnel Venta — Centr y Rustr
-- ============================================================
-- Idempotente: salta orgs inexistentes y orgs ya migradas.
-- Aborta con mensaje claro si hay oportunidades referenciando
-- etapas v5.0 (no esperado en M2 — el cierre de M5 introduce
-- oportunidades). El Funnel Post-venta no se toca.
-- ============================================================
do $$
declare
  v_org_ids uuid[] := array[
    'a1edfbdf-b0a9-45db-a652-5241dc49b48b'::uuid,  -- Centr
    '7503aa44-e844-4376-a332-74daf7e50e9a'::uuid   -- Rustr
  ];
  v_org_id     uuid;
  v_new_count  integer;
  v_referenced integer;
begin
  foreach v_org_id in array v_org_ids
  loop
    if not exists (
      select 1 from public.organizations where id = v_org_id
    ) then
      continue;
    end if;

    select count(*) into v_new_count
      from public.pipeline_stages
     where organization_id = v_org_id
       and funnel = 'venta'
       and name in (
         'Lead nuevo', 'Contactado asesor', 'Contacto calificado',
         'Reunión agendada', 'Diseño de espacios', 'Cotización',
         'Seguimiento para cierre', 'Ganada', 'Perdida'
       );
    if v_new_count = 9 then
      continue;
    end if;

    select count(*) into v_referenced
      from public.opportunities o
      join public.pipeline_stages s on s.id = o.stage_id
     where s.organization_id = v_org_id
       and s.funnel = 'venta';
    if v_referenced > 0 then
      raise exception
        'migration_blocked: org % tiene % oportunidades en etapas Funnel Venta v5.0; migra/reasigna antes de aplicar v5.1',
        v_org_id, v_referenced
        using errcode = 'P0001';
    end if;

    delete from public.pipeline_stages
     where organization_id = v_org_id
       and funnel = 'venta';

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
  end loop;
end;
$$;


-- ============================================================
-- 4) Reglas pre-cargadas: sincronizar nombres de etapa v5.1
-- ============================================================
-- Las orgs existentes (Centr/Rustr) tenían reglas v5.0 cuyo
-- `trigger_config.stage_name` apuntaba a etapas renombradas o
-- eliminadas. Renombra in situ para mantener consistencia.
-- ============================================================

-- Regla "Cotización sin respuesta 24h": "Cotización enviada" → "Cotización"
update public.automation_rules
   set trigger_config = jsonb_set(
         coalesce(trigger_config, '{}'::jsonb),
         '{stage_name}',
         to_jsonb('Cotización'::text),
         true
       )
 where funnel = 'venta'
   and trigger_type = 'stage_aging'
   and name = 'Cotización sin respuesta 24h'
   and (trigger_config ->> 'stage_name') = 'Cotización enviada';

-- Regla "Esperando pago tardío" → "Seguimiento para cierre tardío"
-- (stage "Esperando pago" eliminada en v5.1; reemplazada por
--  "Seguimiento para cierre" semánticamente equivalente).
update public.automation_rules
   set name = 'Seguimiento para cierre tardío',
       trigger_config = jsonb_set(
         coalesce(trigger_config, '{}'::jsonb),
         '{stage_name}',
         to_jsonb('Seguimiento para cierre'::text),
         true
       )
 where funnel = 'venta'
   and trigger_type = 'stage_aging'
   and name = 'Esperando pago tardío';


-- ============================================================
-- 5) bootstrap_organization v5.1 — 9 etapas en el bootstrap
-- ============================================================
-- Sustituye las 7 etapas Funnel Venta del baseline 0010 por las
-- 9 nuevas y ajusta los nombres de etapa referenciados por las
-- reglas pre-cargadas. Resto del bootstrap (Funnel Post-venta,
-- motivos, usuario sistema Histórico, reglas restantes) idéntico.
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

  -- 4) Etapas Funnel Post-venta (sin cambios respecto a v5.0)
  insert into public.pipeline_stages
    (organization_id, funnel, name, position, color, is_initial)
  values
    (v_org_id, 'post_venta', 'Pago confirmado',          1, '#34D399', true),
    (v_org_id, 'post_venta', 'Preparación / Envío',      2, '#60A5FA', false),
    (v_org_id, 'post_venta', 'Entregado',                3, '#10B981', false),
    (v_org_id, 'post_venta', 'Seguimiento post-entrega', 4, '#FBBF24', false),
    (v_org_id, 'post_venta', 'Cliente activo',           5, '#22D3EE', false),
    (v_org_id, 'post_venta', 'Caso problemático',        6, '#EF4444', false);

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

-- Re-aplicar política de acceso post-CREATE OR REPLACE (defensa
-- en profundidad — la signature no cambió, los grants persisten,
-- pero se re-declaran para que esta migración sea autocontenida).
revoke execute on function public.bootstrap_organization(text, citext, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.bootstrap_organization(text, citext, text, text, text)
  to service_role;
