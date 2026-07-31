-- ============================================================
-- Integraciones administrables · 0046 — integration_connections
-- ============================================================
-- Hasta aquí, conectar/cambiar/desconectar Shopify o cualquiera de los DOS
-- Whaapy (Venta y Post-venta) exigía tocar código: `.env.local`/Vercel env,
-- SQL manual sobre `organizations` (discriminadores + `vault_keys`) y scripts
-- tsx para registrar webhooks. Ninguna de esas superficies es alcanzable por
-- el admin de la organización.
--
-- Esta migración aporta la capa de DATOS de la pantalla Admin → Integraciones:
--
--   (1) `integration_connections` — UNA fila por (organización, proveedor) con
--       metadata NO SECRETA para la UI: estado, últimos 4 de cada credencial,
--       URL de callback, resultado del último test, generación de la conexión.
--       Las credenciales SIGUEN viviendo cifradas en `organizations.vault_keys`
--       (solo service_role). La separación es deliberada: la pantalla lee
--       ESTA tabla, así que ningún bug de la capa de presentación puede
--       filtrar un secreto — no hay secreto que filtrar en esta tabla.
--
--   (2) `count_integration_linked_rows` — contador READ-ONLY de las filas que
--       quedarían colgando si se REEMPLAZA el sistema externo. Alimenta el
--       dry-run del flujo de reemplazo (el admin ve los números ANTES).
--
--   (3) `replace_integration_connection` — el reemplazo en sí, ATÓMICO (sin
--       bloque EXCEPTION → Postgres revierte todo si algo falla): cambia el
--       discriminador, DESENLAZA las identidades externas del proveedor,
--       limpia su bag de Vault, incrementa la generación y deja audit.
--
-- Por qué el desenlace es OBLIGATORIO al reemplazar (no opcional):
--   `matchContactIdentity` matchea por `shopify_customer_id` en su tier 1. Si
--   la tienda cambia y conservamos los ids viejos, el customer #123 de la
--   tienda NUEVA matchea contra el contacto que guardaba el #123 de la VIEJA
--   → dos personas distintas fusionadas en silencio. Es la misma clase de bug
--   que ERRORES.md "Teléfono compartido entre dos customers de Shopify".
--   Lo mismo aplica a `whaapy_contact_id` (un PATCH outbound escribiría en el
--   contacto de un desconocido) y a `memberships.whaapy_agent_id`.
--
-- Lo que el reemplazo NO toca: la historia comercial. Oportunidades, órdenes,
-- montos, etapas, historial de etapas, asesores y auditoría quedan intactos.
-- Solo se sueltan los PUNTEROS al sistema externo que dejó de existir.
--
-- `orders.shopify_order_id` es `text not null` con UNIQUE(org, id): no se
-- puede anular sin debilitar el invariante para todo el código que lo asume
-- no-nulo. Se PREFIJA (`unlinked:g<N>:<original>`) — preserva el valor para
-- auditoría, mantiene NOT NULL + unicidad, y garantiza que un id idéntico de
-- la tienda nueva no colisione.
--
-- Además:
--   (4) Se agrega la pestaña `admin-integraciones` a los roles admin/superadmin
--       existentes Y al seed de `bootstrap_organization` (re-CREATE desde la
--       versión VIGENTE, 0041 — ver ERRORES.md "bootstrap_organization
--       re-creado desde una versión vieja").
--   (5) Índice para leer `whaapy_raw_webhooks` por endpoint: el endpoint de
--       Shopify empieza a instrumentar `exit_reason` en esa misma tabla
--       (tenant-independiente), cerrando la deuda "shop desconocido → 200
--       silencioso sin rastro en BD".
-- ============================================================


-- ------------------------------------------------------------
-- 1) integration_connections
-- ------------------------------------------------------------
create table if not exists public.integration_connections (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  -- Universo cerrado. Los dos Whaapy son proveedores SEPARADOS a propósito:
  -- credenciales, businessId y endpoint propios; nada de uno alcanza al otro.
  provider              text not null check (provider in ('shopify', 'whaapy_venta', 'whaapy_postventa')),
  -- Intención del admin, no salud en vivo. La salud efectiva la deriva la app
  -- combinando esto + presencia de credenciales + discriminador + último test.
  status                text not null default 'not_configured'
                        check (status in ('not_configured', 'connected', 'disconnected')),
  -- Últimos 4 caracteres de cada credencial, para mostrar "••••ab12".
  -- Forma: { "client_secret": "ab12", "api_key": "...", "webhook_secret": "..." }
  -- NUNCA la credencial completa: esta tabla es legible por admins de la org.
  credential_last4      jsonb not null default '{}'::jsonb,
  -- URL que el proveedor debe llamar (se muestra para copiar/pegar).
  callback_url          text,
  webhook_registered_at timestamptz,
  -- Resultado del último "Probar conexión" (mensaje sin secretos).
  last_test_at          timestamptz,
  last_test_ok          boolean,
  last_test_message     text,
  connected_at          timestamptz,
  disconnected_at       timestamptz,
  -- Generación de la conexión: arranca en 1 y sube con CADA reemplazo. Sirve
  -- de sufijo estable para los ids desenlazados (`unlinked:g2:...`) y de
  -- rastro de cuántas veces se cambió el sistema externo.
  generation            integer not null default 1 check (generation >= 1),
  updated_by_user_id    uuid references public.user_profiles(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint integration_connections_org_provider_unique unique (organization_id, provider)
);

comment on table public.integration_connections is
  'Metadata NO SECRETA de cada conexión externa (0046): estado, últimos 4 de '
  'las credenciales, callback, último test y generación. Las credenciales '
  'siguen en organizations.vault_keys (service_role). La pantalla Admin → '
  'Integraciones lee SOLO esta tabla — no hay secreto que pueda filtrar.';
comment on column public.integration_connections.provider is
  'shopify | whaapy_venta | whaapy_postventa. Los dos Whaapy son instancias '
  'independientes: credenciales, businessId y endpoint propios.';
comment on column public.integration_connections.credential_last4 is
  'Últimos 4 chars por credencial para la UI ("••••ab12"). NUNCA el valor completo.';
comment on column public.integration_connections.generation is
  'Sube con cada reemplazo del sistema externo. Sufija los ids desenlazados '
  '(orders.shopify_order_id → "unlinked:g<N>:<original>").';

create index if not exists integration_connections_org_idx
  on public.integration_connections (organization_id, provider);

create trigger integration_connections_set_updated_at
  before update on public.integration_connections
  for each row execute function public.tg_set_updated_at();

-- RLS: las 4 tenant policies estándar (macro de 0009 / 0031 / 0038).
alter table public.integration_connections enable row level security;

create policy integration_connections_tenant_select on public.integration_connections
  for select using (organization_id = public.current_organization_id());

create policy integration_connections_tenant_insert on public.integration_connections
  for insert with check (organization_id = public.current_organization_id());

create policy integration_connections_tenant_update on public.integration_connections
  for update using (organization_id = public.current_organization_id())
  with check (organization_id = public.current_organization_id());

create policy integration_connections_tenant_delete on public.integration_connections
  for delete using (organization_id = public.current_organization_id());


-- ------------------------------------------------------------
-- 2) Backfill — una fila por (org, proveedor) con el estado REAL
-- ------------------------------------------------------------
-- El estado se deriva de lo que hay hoy en BD: credenciales en `vault_keys`
-- MÁS el discriminador poblado. Una org que hoy funciona por FALLBACK DE ENV
-- (bag de Vault vacío) queda como `not_configured` — y eso es correcto: con
-- los getters fail-closed de esta misma entrega, esa org efectivamente NO
-- tiene credenciales propias. El script `maintenance:adopt-env-credentials`
-- materializa el env a Vault antes del deploy.
insert into public.integration_connections
  (organization_id, provider, status, credential_last4, connected_at)
select
  o.id,
  p.provider,
  case when p.is_connected then 'connected' else 'not_configured' end,
  p.last4,
  case when p.is_connected then o.created_at else null end
from public.organizations o
cross join lateral (
  values
    (
      'shopify',
      (o.vault_keys -> 'shopify' ->> 'client_id') is not null
        and (o.vault_keys -> 'shopify' ->> 'client_secret') is not null
        and o.shopify_store_domain is not null,
      jsonb_strip_nulls(jsonb_build_object(
        'client_id',     right(o.vault_keys -> 'shopify' ->> 'client_id', 4),
        'client_secret', right(o.vault_keys -> 'shopify' ->> 'client_secret', 4)
      ))
    ),
    (
      'whaapy_venta',
      (o.vault_keys -> 'whaapy' ->> 'api_key') is not null
        and o.whaapy_business_id is not null,
      jsonb_strip_nulls(jsonb_build_object(
        'api_key',        right(o.vault_keys -> 'whaapy' ->> 'api_key', 4),
        'webhook_secret', right(o.vault_keys -> 'whaapy' ->> 'webhook_secret', 4)
      ))
    ),
    (
      'whaapy_postventa',
      (o.vault_keys -> 'whaapy_postventa' ->> 'api_key') is not null
        and o.whaapy_postventa_business_id is not null,
      jsonb_strip_nulls(jsonb_build_object(
        'api_key',        right(o.vault_keys -> 'whaapy_postventa' ->> 'api_key', 4),
        'webhook_secret', right(o.vault_keys -> 'whaapy_postventa' ->> 'webhook_secret', 4),
        'inbound_token',  right(o.vault_keys -> 'whaapy_postventa' ->> 'inbound_token', 4)
      ))
    )
) as p(provider, is_connected, last4)
on conflict (organization_id, provider) do nothing;


-- ------------------------------------------------------------
-- 3) count_integration_linked_rows — dry-run READ-ONLY
-- ------------------------------------------------------------
-- Devuelve cuántas filas quedarían colgando si se reemplaza el sistema
-- externo de `p_provider`. Es la MISMA definición de "enlazado" que usa el
-- desenlace de `replace_integration_connection` — si las dos divergen, el
-- dry-run miente. Cualquier cambio a una toca la otra.
create or replace function public.count_integration_linked_rows(
  p_organization_id uuid,
  p_provider        text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_contacts    bigint := 0;
  v_opps        bigint := 0;
  v_orders      bigint := 0;
  v_memberships bigint := 0;
  v_tags        bigint := 0;
begin
  if p_provider = 'shopify' then
    select count(*) into v_contacts
      from public.contacts c
      where c.organization_id = p_organization_id
        and c.shopify_customer_id is not null;

    select count(*) into v_opps
      from public.opportunities op
      where op.organization_id = p_organization_id
        and (op.shopify_draft_order_id is not null or op.shopify_order_id is not null);

    select count(*) into v_orders
      from public.orders ord
      where ord.organization_id = p_organization_id
        and ord.shopify_order_id not like 'unlinked:g%';

    select count(*) into v_tags
      from public.tag_mappings tm
      where tm.organization_id = p_organization_id;

  elsif p_provider = 'whaapy_venta' then
    select count(*) into v_contacts
      from public.contacts c
      where c.organization_id = p_organization_id
        and c.whaapy_contact_id is not null;

    select count(*) into v_memberships
      from public.memberships m
      where m.organization_id = p_organization_id
        and m.whaapy_agent_id is not null;

  elsif p_provider = 'whaapy_postventa' then
    -- El Whaapy de Post-venta no deja identidad local: la plataforma lo
    -- matchea por TELÉFONO y el `centrhub_opportunity_id` vive del lado de
    -- Whaapy (custom_field). No hay nada local que desenlazar → 0 en todo.
    null;

  else
    raise exception 'unknown_provider: %', p_provider;
  end if;

  return jsonb_build_object(
    'contacts',    v_contacts,
    'opportunities', v_opps,
    'orders',      v_orders,
    'memberships', v_memberships,
    'tag_mappings', v_tags
  );
end;
$$;

revoke execute on function public.count_integration_linked_rows(uuid, text)
  from public, anon, authenticated;
grant  execute on function public.count_integration_linked_rows(uuid, text)
  to service_role;


-- ------------------------------------------------------------
-- 4) replace_integration_connection — reemplazo ATÓMICO
-- ------------------------------------------------------------
-- SIN bloque EXCEPTION: si cualquier paso falla, Postgres revierte TODO
-- (mismo patrón que trigger_f1_to_f2 y handoff_outbound_opportunity). Un
-- reemplazo a medias — discriminador nuevo con ids viejos colgando — es
-- exactamente el estado que produce la fusión silenciosa de contactos.
--
-- Invariantes:
--   INV-1 desenlace: suelta TODA identidad externa del proveedor (ningún id
--         del sistema viejo sobrevive como clave de match).
--   INV-2 historia:  NO borra oportunidades, órdenes ni historial — solo
--         suelta punteros. Ningún DELETE sobre tablas de negocio.
--   INV-3 vault:     limpia el bag de credenciales del proveedor (las del
--         sistema viejo no sirven y no deben quedar accesibles).
--   INV-4 generación: incrementa `generation` y prefija con ella los ids que
--         no se pueden anular (orders.shopify_order_id es NOT NULL).
--   INV-5 audit:     deja `integration_connection_replaced` con los conteos.
create or replace function public.replace_integration_connection(
  p_organization_id   uuid,
  p_provider          text,
  p_new_discriminator text,
  p_actor_user_id     uuid default null,
  p_new_store_url     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_generation  integer;
  v_prefix      text;
  v_counts      jsonb;
  v_old         text;
begin
  if p_new_discriminator is null or btrim(p_new_discriminator) = '' then
    raise exception 'empty_discriminator';
  end if;

  -- Lock de la fila de conexión: serializa dos reemplazos concurrentes.
  select generation into v_generation
    from public.integration_connections
    where organization_id = p_organization_id and provider = p_provider
    for update;

  if v_generation is null then
    raise exception 'connection_row_missing: % / %', p_organization_id, p_provider;
  end if;

  -- Conteos ANTES de desenlazar (lo que el dry-run le mostró al admin).
  v_counts := public.count_integration_linked_rows(p_organization_id, p_provider);

  v_generation := v_generation + 1;
  v_prefix := 'unlinked:g' || v_generation || ':';

  if p_provider = 'shopify' then
    select shopify_store_domain into v_old
      from public.organizations where id = p_organization_id for update;

    -- INV-1: soltar identidades externas de Shopify.
    update public.contacts
      set shopify_customer_id = null,
          shopify_tags        = '{}'::text[]
      where organization_id = p_organization_id
        and (shopify_customer_id is not null or shopify_tags <> '{}'::text[]);

    update public.opportunities
      set shopify_draft_order_id = null,
          shopify_order_id       = null
      where organization_id = p_organization_id
        and (shopify_draft_order_id is not null or shopify_order_id is not null);

    -- INV-4: `orders.shopify_order_id` es NOT NULL + UNIQUE → se prefija en
    -- vez de anularse. El valor original queda legible tras el prefijo.
    update public.orders
      set shopify_order_id = v_prefix || shopify_order_id
      where organization_id = p_organization_id
        and shopify_order_id not like 'unlinked:g%';

    -- INV-2/INV-3: discriminador nuevo + bag de Vault limpio. El access_token
    -- cacheado se va con el bag (era de la tienda vieja).
    update public.organizations
      set shopify_store_domain = p_new_discriminator,
          shopify_store_url    = coalesce(p_new_store_url, shopify_store_url),
          vault_keys           = vault_keys - 'shopify'
      where id = p_organization_id;

  elsif p_provider = 'whaapy_venta' then
    select whaapy_business_id into v_old
      from public.organizations where id = p_organization_id for update;

    -- `deleted_in_whaapy` NO se toca a propósito: es un hecho histórico (ese
    -- contacto se archivó, y sus opps se cancelaron con él). Resetearlo lo
    -- devolvería a las vistas activas sin restaurar nada. Con
    -- `whaapy_contact_id` nulo el badge ya deriva "fuera de Whaapy".
    -- `last_whaapy_activity_at` SÍ se limpia: un valor de la instancia vieja
    -- haría que R12 crea que el contacto tuvo actividad reciente y suprima el
    -- "Lead nuevo" de su primera conversación en la instancia nueva.
    update public.contacts
      set whaapy_contact_id       = null,
          last_whaapy_activity_at = null
      where organization_id = p_organization_id
        and (whaapy_contact_id is not null
             or last_whaapy_activity_at is not null);

    -- El mapeo agente↔asesor pertenece a la instancia vieja: sin esto, un
    -- `assigned_agent_id` saliente apuntaría a un agente inexistente.
    update public.memberships
      set whaapy_agent_id = null
      where organization_id = p_organization_id
        and whaapy_agent_id is not null;

    update public.organizations
      set whaapy_business_id = p_new_discriminator,
          vault_keys         = vault_keys - 'whaapy'
      where id = p_organization_id;

  elsif p_provider = 'whaapy_postventa' then
    select whaapy_postventa_business_id into v_old
      from public.organizations where id = p_organization_id for update;

    -- Sin identidad local que soltar (match por teléfono). Solo se cambia el
    -- discriminador y se limpian credenciales.
    update public.organizations
      set whaapy_postventa_business_id = p_new_discriminator,
          vault_keys                   = vault_keys - 'whaapy_postventa'
      where id = p_organization_id;

  else
    raise exception 'unknown_provider: %', p_provider;
  end if;

  update public.integration_connections
    set generation         = v_generation,
        status             = 'not_configured',
        credential_last4   = '{}'::jsonb,
        webhook_registered_at = null,
        last_test_at       = null,
        last_test_ok       = null,
        last_test_message  = null,
        connected_at       = null,
        disconnected_at    = null,
        updated_by_user_id = p_actor_user_id
    where organization_id = p_organization_id and provider = p_provider;

  -- INV-5: auditoría con los conteos reales del desenlace.
  insert into public.audit_log
    (organization_id, actor_user_id, event_type, entity_type, entity_id, payload)
  values (
    p_organization_id,
    p_actor_user_id,
    'integration_connection_replaced',
    'integration_connection',
    null,
    jsonb_build_object(
      'provider',           p_provider,
      'generation',         v_generation,
      'previous_discriminator', v_old,
      'new_discriminator',  p_new_discriminator,
      'unlinked',           v_counts
    )
  );

  return jsonb_build_object(
    'provider',   p_provider,
    'generation', v_generation,
    'unlinked',   v_counts
  );
end;
$$;

revoke execute on function public.replace_integration_connection(uuid, text, text, uuid, text)
  from public, anon, authenticated;
grant  execute on function public.replace_integration_connection(uuid, text, text, uuid, text)
  to service_role;


-- ------------------------------------------------------------
-- 5) Pestaña admin-integraciones en los roles EXISTENTES
-- ------------------------------------------------------------
-- Idempotente: solo agrega la key a los roles que ya ven el panel de
-- administración y aún no la tienen. Los roles custom sin admin no cambian.
update public.roles
  set allowed_tabs = allowed_tabs || array['admin-integraciones']
  where key in ('admin', 'superadmin')
    and not ('admin-integraciones' = any(allowed_tabs));


-- ------------------------------------------------------------
-- 6) bootstrap_organization — re-CREATE desde la VIGENTE (0041)
-- ------------------------------------------------------------
-- Único cambio respecto de 0041: `admin-integraciones` en el allowed_tabs de
-- superadmin y admin. TODO lo demás (seed v5.1 de 9 etapas Venta, 7 de
-- Post-venta con "Caso cerrado" is_won terminal, 3 de Outbound, 6 motivos,
-- 6 reglas, usuario sistema "Histórico") se arrastra VERBATIM — ver ERRORES.md
-- "create or replace reemplaza el cuerpo ENTERO" y "bootstrap_organization
-- re-creado desde una versión vieja (0039 regresó el seed a v5.0)".
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
            'admin-integraciones','admin-roles'], true),
    (v_org_id, 'admin', 'Administrador', 'all',
      array['mi-dia','pipeline','contactos','whaapy','dashboard',
            'admin-etapas','admin-motivos','admin-mapeo-tags','admin-reglas',
            'admin-metas','admin-usuarios','admin-webhooks','admin-agentes-whaapy',
            'admin-integraciones','admin-roles'], true),
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
-- 7) Observabilidad del endpoint de Shopify (item 7)
-- ------------------------------------------------------------
-- `whaapy_raw_webhooks` es la única tabla de ingreso que NO depende de
-- resolución de tenant (por eso sobrevive al path `unknown_shop`, que corre
-- antes de conocer la organización). El endpoint de Shopify empieza a escribir
-- ahí con `endpoint='shopify'`. Índice espejo del de 0016.
create index if not exists whaapy_raw_webhooks_shopify_exit_idx
  on public.whaapy_raw_webhooks (received_at desc, exit_reason)
  where endpoint = 'shopify';
