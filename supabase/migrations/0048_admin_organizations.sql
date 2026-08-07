-- ============================================================
-- 0048 — Admin → Organizaciones
-- ============================================================
-- Da UI a lo que hasta hoy solo era una llamada SQL manual: crear una
-- organización nueva (una tienda más) y cambiarle el nombre visible a una
-- existente, sin tocar código ni SQL.
--
-- Tres piezas:
--   1) Pestaña `admin-organizaciones` en los roles admin/superadmin
--      EXISTENTES (idempotente).
--   2) `bootstrap_organization` re-CREADA desde la VIGENTE (0046) con esa
--      key añadida — ver ERRORES.md "create or replace reemplaza el cuerpo
--      ENTERO": copiar desde la última, NUNCA desde una versión vieja.
--   3) `bootstrap_organization_with_owner` — envuelve a la anterior y le
--      cuelga la membresía de quien la crea, en UNA sola transacción. Sin
--      esto una creación a medias deja un tenant al que nadie puede entrar
--      (habría que rescatarlo por SQL, justo lo que esta pantalla evita).
--
-- El `slug` NO se toca nunca después de crear: es el discriminador que la
-- automation de Whaapy Post-venta manda en el body y el que consumen todos
-- los scripts (`--org-slug`). Renombrar = solo `organizations.name`.
-- ============================================================


-- ------------------------------------------------------------
-- 1) Pestaña admin-organizaciones en los roles EXISTENTES
-- ------------------------------------------------------------
-- Idempotente: solo la agrega a los roles que ya ven el panel de
-- administración y aún no la tienen. Los roles custom no cambian.
update public.roles
  set allowed_tabs = allowed_tabs || array['admin-organizaciones']
  where key in ('admin', 'superadmin')
    and not ('admin-organizaciones' = any(allowed_tabs));


-- ------------------------------------------------------------
-- 2) bootstrap_organization — re-CREATE desde la VIGENTE (0046)
-- ------------------------------------------------------------
-- Único cambio respecto de 0046: `admin-organizaciones` en el allowed_tabs
-- de superadmin y admin. TODO lo demás (roles de sistema + SDR, filas de
-- integration_connections, usuario sistema "Histórico", seed v5.1 de 9
-- etapas de Venta, 7 de Post-venta con "Caso cerrado" is_won terminal, 3 de
-- Outbound, 6 motivos, 6 reglas) se arrastra VERBATIM.
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
            'admin-integraciones','admin-organizaciones','admin-roles'], true),
    (v_org_id, 'admin', 'Administrador', 'all',
      array['mi-dia','pipeline','contactos','whaapy','dashboard',
            'admin-etapas','admin-motivos','admin-mapeo-tags','admin-reglas',
            'admin-metas','admin-usuarios','admin-webhooks','admin-agentes-whaapy',
            'admin-integraciones','admin-organizaciones','admin-roles'], true),
    (v_org_id, 'vendedor', 'Vendedor', 'own',
      array['mi-dia','pipeline','contactos','whaapy','dashboard'], true),
    (v_org_id, 'sdr', 'SDR', 'all',
      array['mi-dia','pipeline','contactos','whaapy','dashboard'], false);

  -- 1.75) Filas de conexión de integraciones (0046) — una por proveedor, en
  --       estado `not_configured`. La pantalla Admin → Integraciones las
  --       espera existentes (el reemplazo hace lock sobre la fila).
  insert into public.integration_connections (organization_id, provider)
  values
    (v_org_id, 'shopify'),
    (v_org_id, 'whaapy_venta'),
    (v_org_id, 'whaapy_postventa');

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

  -- 4) Etapas Funnel Post-venta — v5.1 + "Caso cerrado" terminal
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

  -- 5) Motivos de pérdida
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
-- 3) bootstrap_organization_with_owner — org + su primer miembro
-- ------------------------------------------------------------
-- Atómica a propósito: `bootstrap_organization` siembra un tenant completo
-- pero SIN nadie que pueda entrar (su única membership es la del usuario
-- sistema "Histórico", inactiva por diseño). Si la membresía del creador se
-- insertara en una segunda llamada desde TS y esa fallara, quedaría una
-- organización inaccesible desde la UI. Al vivir dentro de la misma función
-- plpgsql, ambas cosas comparten transacción: o hay org con dueño, o no hay
-- org.
--
-- `p_owner_role` debe ser la key de un rol de la org RECIÉN creada — el FK
-- compuesto memberships(organization_id, role) → roles(organization_id, key)
-- lo garantiza, así que un rol inventado revienta la transacción entera.
create or replace function public.bootstrap_organization_with_owner(
  p_name       text,
  p_slug       citext,
  p_owner_user uuid,
  p_owner_role text default 'admin'
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_org_id    uuid;
  v_full_name text;
begin
  if p_owner_user is null then
    raise exception 'bootstrap_organization_with_owner: p_owner_user es obligatorio';
  end if;

  select coalesce(u.raw_user_meta_data ->> 'full_name', split_part(u.email, '@', 1))
    into v_full_name
    from auth.users u
   where u.id = p_owner_user;

  if v_full_name is null then
    raise exception 'bootstrap_organization_with_owner: el usuario % no existe', p_owner_user;
  end if;

  v_org_id := public.bootstrap_organization(p_name, p_slug);

  -- Defensivo: un usuario que llegó por SQL crudo podría no tener perfil.
  insert into public.user_profiles (id, full_name)
  values (p_owner_user, v_full_name)
  on conflict (id) do nothing;

  insert into public.memberships (user_id, organization_id, role, is_active)
  values (p_owner_user, v_org_id, p_owner_role, true);

  return v_org_id;
end;
$$;

revoke execute on function public.bootstrap_organization_with_owner(text, citext, uuid, text)
  from public, anon, authenticated;
grant  execute on function public.bootstrap_organization_with_owner(text, citext, uuid, text)
  to service_role;
