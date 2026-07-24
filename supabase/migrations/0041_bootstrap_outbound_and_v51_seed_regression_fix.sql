-- ============================================================
-- Outbound · 0041 — bootstrap_organization: fix regresión v5.0 + Outbound
-- ============================================================
-- DOS cosas en una sola re-CREATE (ambas tocan el mismo cuerpo):
--
--   (1) FIX DE REGRESIÓN. La migración 0039 re-CREÓ bootstrap_organization
--       rebasándose sobre la versión 0010 (v5.0) en vez de la VIGENTE
--       (0033, v5.1) — su cabezal decía "desde la versión VIGENTE (0010)",
--       pero 0010 NO era la vigente. Resultado: toda org nueva creada tras
--       0039 nace con el bloque de seed v5.0 (7 etapas Venta "Calificado /
--       Cotización enviada / En negociación / Esperando pago", Post-venta
--       "Preparación / Cliente activo", y reglas ancladas a esos nombres) →
--       automatizaciones rotas en silencio (draft_orders/create busca
--       "Cotización" y no existe; dashboard sin banda "Contacto calificado";
--       motor Post-venta sin "Envío en curso"/"Caso cerrado"). Centr/Rustr
--       se salvaron porque sus FILAS se arreglaron por data-migrations
--       (0013/0019/0033); la FUNCIÓN quedó regresada. Es la misma clase de
--       bug que ERRORES.md "create or replace reemplaza el cuerpo ENTERO":
--       toda redefinición parte de la VIGENTE, no de una vieja.
--       → Se restaura el bloque de seed v5.1 EXACTO de 0033 (9 etapas Venta,
--         7 Post-venta con "Caso cerrado" is_won terminal, 6 reglas v5.1).
--
--   (2) OUTBOUND. Se agrega el bloque de etapas del tercer funnel 'outbound'
--       (Fase 1). 3 etapas administrables como las demás; sin won/lost (la
--       salida del funnel es el handoff a Venta, Fase 3).
--
-- Se CONSERVA el bloque de roles que 0039 agregó (superadmin/admin/vendedor
-- + SDR), sembrado ANTES de la primera membership (el FK memberships→roles
-- lo exige). Es lo único correcto que 0039 aportó a esta función.
--
-- Contrato de invariantes (además de los de 0033): el seed Venta usa los
-- nombres canónicos que resuelven las automatizaciones (stage-automation.ts);
-- las etapas Outbound NO reusan esos nombres ("Cliente calificado" ≠
-- "Contacto calificado").
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

  -- 1.5) Roles de sistema + SDR (0039) — ANTES de cualquier membership
  --      (el FK compuesto memberships(org, role) → roles(org, key) exige
  --      que el rol exista primero).
  insert into public.roles (organization_id, key, label, data_scope, allowed_tabs, is_system)
  values
    (v_org_id, 'superadmin', 'Superadmin', 'all',
      array['mi-dia','pipeline','contactos','whaapy','dashboard',
            'admin-etapas','admin-motivos','admin-mapeo-tags','admin-reglas',
            'admin-metas','admin-usuarios','admin-webhooks','admin-agentes-whaapy',
            'admin-roles'], true),
    (v_org_id, 'admin', 'Administrador', 'all',
      array['mi-dia','pipeline','contactos','whaapy','dashboard',
            'admin-etapas','admin-motivos','admin-mapeo-tags','admin-reglas',
            'admin-metas','admin-usuarios','admin-webhooks','admin-agentes-whaapy',
            'admin-roles'], true),
    (v_org_id, 'vendedor', 'Vendedor', 'own',
      array['mi-dia','pipeline','contactos','whaapy','dashboard'], true),
    (v_org_id, 'sdr', 'SDR', 'all',
      array['mi-dia','pipeline','contactos','whaapy','dashboard'], false);

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

  -- 3) Etapas Funnel Venta — v5.1 (9 etapas, doctrina §3.3.9) [RESTAURADO de 0033]
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

  -- 4) Etapas Funnel Post-venta — v5.1 + "Caso cerrado" terminal [RESTAURADO de 0033]
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

  -- 4.5) Etapas Funnel Outbound — v5.2 (3 etapas, Fase 1). Sin won/lost:
  --      la salida del funnel es el handoff a Venta (Fase 3). Nombres NO
  --      colisionan con los canónicos de stage-automation.ts.
  insert into public.pipeline_stages
    (organization_id, funnel, name, position, color, is_initial)
  values
    (v_org_id, 'outbound', 'Cliente contactado', 1, '#C084FC', true),
    (v_org_id, 'outbound', 'Revisión agendada',  2, '#818CF8', false),
    (v_org_id, 'outbound', 'Cliente calificado', 3, '#22D3EE', false);

  -- 5) Motivos de pérdida [RESTAURADO de 0033]
  insert into public.loss_reasons (organization_id, name) values
    (v_org_id, 'Precio'),
    (v_org_id, 'Tiempo'),
    (v_org_id, 'Competencia'),
    (v_org_id, 'Ghosting (sin respuesta del cliente)'),
    (v_org_id, 'No era buen fit'),
    (v_org_id, 'Otro');

  -- 6) Reglas pre-cargadas — 4 activas + 2 inactivas (v5.1) [RESTAURADO de 0033]
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


-- ------------------------------------------------------------
-- Backfill — sembrar el funnel Outbound en orgs EXISTENTES
-- ------------------------------------------------------------
-- Idempotente: solo inserta en orgs que aún no tienen etapas 'outbound'.
-- NO toca Venta/Post-venta (las filas de Centr/Rustr ya son v5.1 correctas
-- por 0013/0019/0033 — la regresión de 0039 fue solo en la FUNCIÓN, no en
-- los datos existentes).
insert into public.pipeline_stages
  (organization_id, funnel, name, position, color, is_initial)
select o.id, 'outbound', s.name, s.position, s.color, s.is_initial
from public.organizations o
cross join (
  values
    ('Cliente contactado', 1, '#C084FC', true),
    ('Revisión agendada',  2, '#818CF8', false),
    ('Cliente calificado', 3, '#22D3EE', false)
) as s(name, position, color, is_initial)
where not exists (
  select 1 from public.pipeline_stages ps
  where ps.organization_id = o.id
    and ps.funnel = 'outbound'
);
