-- ============================================================
-- Roles configurables · 0039
-- ============================================================
-- Feature "Roles configurables, invitaciones por rol y rol SDR".
--
-- Hasta aquí el rol era un `text` con CHECK (`superadmin|admin|vendedor`)
-- y toda la autorización se reducía a un booleano `isAdmin` cableado en
-- ~30 sitios. Esta migración introduce un modelo de permisos de DOS EJES,
-- configurable por organización:
--
--   (A) QUÉ PESTAÑAS ve el rol   → `roles.allowed_tabs` (array de tab keys)
--   (B) QUÉ DATOS alcanza el rol → `roles.data_scope` ('own' | 'all')
--
-- "Ver es operar": no hay un tercer eje por-acción. Si un rol ve una
-- pestaña general, opera en ella con su alcance de datos.
--
-- Invariantes protegidos:
--   * Los roles de SISTEMA (`superadmin`, `admin`, `vendedor`) llevan
--     `is_system=true`: no se borran ni se pueden dejar sin pestañas.
--   * `memberships.role` pasa de CHECK a FK compuesto → roles(org, key):
--     un membership SIEMPRE apunta a un rol que existe en su org, y un rol
--     con usuarios NO se puede borrar (FK restrict → guardrail en BD, además
--     del pre-chequeo en la app).
--   * "Solo los vendedores son asesores": NO se materializa como flag
--     configurable — la asignabilidad sigue cableada al `role='vendedor'`
--     en `listActiveRealVendors`/`listRealVendorsForMapping`. Un rol nuevo
--     (SDR o custom) nunca entra a round-robin / selector / tags / Whaapy
--     porque su `key` != 'vendedor'.
--
-- El rol SDR se siembra aquí (general tabs + data_scope 'all', NO sistema →
-- editable/borrable desde el constructor).
-- ============================================================

-- ------------------------------------------------------------
-- 1) Tabla roles — catálogo de roles por organización
-- ------------------------------------------------------------
create table if not exists public.roles (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  -- Identificador estable del rol dentro de la org. Es el valor que vive en
  -- `memberships.role`. Slug inmutable ('admin','vendedor','sdr', o custom).
  key              text not null,
  -- Nombre visible (español) — se muestra en badges, selects y el constructor.
  label            text not null,
  -- Eje B — alcance de datos: 'own' (solo lo asignado a mí) | 'all' (toda la org).
  data_scope       text not null default 'own' check (data_scope in ('own', 'all')),
  -- Eje A — pestañas visibles (keys del TAB_REGISTRY de la app). Vacío = rol
  -- sin pestañas (bloqueado por la app: un rol así deja al usuario en estado roto).
  allowed_tabs     text[] not null default '{}',
  -- Roles de sistema (admin/vendedor/superadmin): protegidos de borrado y de
  -- quedar sin pestañas. Los custom (incl. SDR sembrado) son editables/borrables.
  is_system        boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint roles_org_key_unique unique (organization_id, key)
);

comment on table public.roles is
  'Catálogo de roles configurables por organización (0039). Modelo de dos '
  'ejes: allowed_tabs (qué pestañas ve) + data_scope (qué datos alcanza). '
  'is_system protege admin/vendedor/superadmin de borrado y de quedar sin tabs.';
comment on column public.roles.key is
  'Slug estable del rol dentro de la org — el valor de memberships.role. Inmutable.';
comment on column public.roles.data_scope is
  '"own" = solo datos asignados al usuario; "all" = toda la org (como admin).';
comment on column public.roles.allowed_tabs is
  'Keys de pestañas visibles (TAB_REGISTRY). Vacío = sin pestañas (bloqueado por la app).';

create index if not exists roles_organization_idx
  on public.roles (organization_id);

create trigger roles_set_updated_at
  before update on public.roles
  for each row execute function public.tg_set_updated_at();

-- ------------------------------------------------------------
-- 2) RLS — las 4 tenant policies estándar (espejo de 0009 / 0038)
-- ------------------------------------------------------------
alter table public.roles enable row level security;

create policy roles_tenant_select on public.roles
  for select using (organization_id = public.current_organization_id());

create policy roles_tenant_insert on public.roles
  for insert with check (organization_id = public.current_organization_id());

create policy roles_tenant_update on public.roles
  for update using (organization_id = public.current_organization_id())
  with check (organization_id = public.current_organization_id());

create policy roles_tenant_delete on public.roles
  for delete using (organization_id = public.current_organization_id());

-- ------------------------------------------------------------
-- 3) Sembrar los roles de sistema + SDR para TODAS las orgs existentes
-- ------------------------------------------------------------
-- Debe correr ANTES de agregar el FK memberships→roles: cada (org, role)
-- vivo tiene que tener su fila en roles o el FK fallaría al validar.
-- Idempotente (on conflict do nothing).
--
-- Tab keys (deben coincidir 1:1 con TAB_REGISTRY en lib/auth/capabilities.ts):
--   Generales: mi-dia, pipeline, contactos, whaapy, dashboard
--   Admin:     admin-etapas, admin-motivos, admin-mapeo-tags, admin-reglas,
--              admin-metas, admin-usuarios, admin-webhooks, admin-agentes-whaapy,
--              admin-roles
insert into public.roles (organization_id, key, label, data_scope, allowed_tabs, is_system)
select o.id, r.key, r.label, r.data_scope, r.allowed_tabs, r.is_system
from public.organizations o
cross join (
  values
    ('superadmin', 'Superadmin', 'all',
      array['mi-dia','pipeline','contactos','whaapy','dashboard',
            'admin-etapas','admin-motivos','admin-mapeo-tags','admin-reglas',
            'admin-metas','admin-usuarios','admin-webhooks','admin-agentes-whaapy',
            'admin-roles'], true),
    ('admin', 'Administrador', 'all',
      array['mi-dia','pipeline','contactos','whaapy','dashboard',
            'admin-etapas','admin-motivos','admin-mapeo-tags','admin-reglas',
            'admin-metas','admin-usuarios','admin-webhooks','admin-agentes-whaapy',
            'admin-roles'], true),
    ('vendedor', 'Vendedor', 'own',
      array['mi-dia','pipeline','contactos','whaapy','dashboard'], true),
    ('sdr', 'SDR', 'all',
      array['mi-dia','pipeline','contactos','whaapy','dashboard'], false)
) as r(key, label, data_scope, allowed_tabs, is_system)
on conflict (organization_id, key) do nothing;

-- ------------------------------------------------------------
-- 4) memberships.role: CHECK → FK compuesto a roles(org, key)
-- ------------------------------------------------------------
-- Quitar el CHECK que limitaba a los 3 valores fijos. El universo de roles
-- ahora es dinámico (la tabla roles), así que la integridad la da el FK.
alter table public.memberships
  drop constraint if exists memberships_role_check;

-- FK compuesto: un membership apunta a un rol EXISTENTE de su misma org.
-- DEFERRABLE INITIALLY DEFERRED: al borrar una organización, el cascade
-- borra memberships y roles como hermanos; diferir la validación al commit
-- evita un falso positivo por orden de cascada. Fuera de ese caso, borrar un
-- rol con memberships vivos viola el FK (guardrail en BD; la app pre-chequea
-- para dar un mensaje accionable).
alter table public.memberships
  add constraint memberships_role_fk
  foreign key (organization_id, role)
  references public.roles (organization_id, key)
  deferrable initially deferred;

-- ------------------------------------------------------------
-- 5) bootstrap_organization — re-CREATE desde la versión VIGENTE (0010)
--    agregando el seed de roles ANTES de la primera membership.
-- ------------------------------------------------------------
-- Regla ERRORES.md (0027/0030): toda redefinición parte de la versión
-- vigente y arrastra TODA la lógica; el único delta aquí es el bloque
-- "1.5) roles" — el resto es idéntico a 0010.
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
  -- 1.5) Roles de sistema + SDR (0039) — ANTES de cualquier membership
  --      (el FK memberships→roles exige que el rol exista primero).
  -- ------------------------------------------------------------
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
    (v_org_id, 'venta', 'Perdida',            7, '#EF4444',   0.00, false, false, true,  true);

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
