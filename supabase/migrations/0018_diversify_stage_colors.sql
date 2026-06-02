-- ============================================================
-- 0018 — Diversifica la paleta de colores de pipeline_stages
-- ============================================================
-- Lote polish M6 ronda 2 — #8.
--
-- La paleta v5.1 (migración 0013) tenía clusters visuales: tres
-- etapas seguidas en tonos azul/indigo casi indistinguibles para
-- el usuario. Esta migración aplica una paleta diversa, alineada
-- con la identidad Centr (blanco/negro + amarillo) y garantiza
-- contraste fuerte entre columnas adyacentes.
--
-- Estrategia: UPDATE en filas existentes que tengan colores en el
-- set de "defaults v5.1" — preserva personalizaciones del admin.
-- ============================================================

-- ----------------------------------------------------------------
-- 1) Update filas existentes — venta
-- ----------------------------------------------------------------
-- Solo actualizamos cuando el color actual coincide con el default
-- v5.1 para esa posición. Si el admin lo cambió desde M7, lo
-- respetamos.

-- Lead nuevo (pos 1): gris → slate-400
update public.pipeline_stages
   set color = '#94A3B8'
 where funnel = 'venta' and position = 1 and color = '#9CA3AF';

-- Contactado asesor (pos 2): blue-400 → cyan-500
update public.pipeline_stages
   set color = '#06B6D4'
 where funnel = 'venta' and position = 2 and color = '#60A5FA';

-- Contacto calificado (pos 3): blue-500 → sky-500
update public.pipeline_stages
   set color = '#0EA5E9'
 where funnel = 'venta' and position = 3 and color = '#3B82F6';

-- Reunión agendada (pos 4): indigo-500 → violet-500
update public.pipeline_stages
   set color = '#8B5CF6'
 where funnel = 'venta' and position = 4 and color = '#6366F1';

-- Diseño de espacios (pos 5): violet-500 → pink-500
update public.pipeline_stages
   set color = '#EC4899'
 where funnel = 'venta' and position = 5 and color = '#8B5CF6';

-- Cotización (pos 6): emerald-400 → amber-500
update public.pipeline_stages
   set color = '#F59E0B'
 where funnel = 'venta' and position = 6 and color = '#34D399';

-- Seguimiento para cierre (pos 7): amber-400 → orange-500
update public.pipeline_stages
   set color = '#F97316'
 where funnel = 'venta' and position = 7 and color = '#FBBF24';

-- Ganada (pos 8) ya es emerald-500 (#10B981) — se mantiene.
-- Perdida (pos 9) ya es red-500 (#EF4444) — se mantiene.

-- ----------------------------------------------------------------
-- 2) Update filas existentes — post_venta
-- ----------------------------------------------------------------

-- Pago confirmado (pos 1): emerald-400 → teal-500
update public.pipeline_stages
   set color = '#14B8A6'
 where funnel = 'post_venta' and position = 1 and color = '#34D399';

-- Preparación / Envío (pos 2): blue-400 → indigo-500
update public.pipeline_stages
   set color = '#6366F1'
 where funnel = 'post_venta' and position = 2 and color = '#60A5FA';

-- Entregado (pos 3): emerald-500 — se mantiene.

-- Seguimiento post-entrega (pos 4): amber-400 → fuchsia-500
update public.pipeline_stages
   set color = '#D946EF'
 where funnel = 'post_venta' and position = 4 and color = '#FBBF24';

-- Cliente activo (pos 5): cyan-400 → amber-500
update public.pipeline_stages
   set color = '#F59E0B'
 where funnel = 'post_venta' and position = 5 and color = '#22D3EE';

-- Caso problemático (pos 6) ya es red-500 — se mantiene.

-- ----------------------------------------------------------------
-- 3) Actualiza la función de bootstrap para nuevas orgs
-- ----------------------------------------------------------------

create or replace function public.bootstrap_organization(
  p_name                text,
  p_slug                text,
  p_shopify_store_url   text default null,
  p_shopify_domain      text default null,
  p_whaapy_business     text default null
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
  insert into public.organizations
    (name, slug, shopify_store_url, shopify_store_domain, whaapy_business_id)
  values
    (p_name, p_slug, p_shopify_store_url, p_shopify_domain, p_whaapy_business)
  returning id into v_org_id;

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
  values (v_historic_uid, 'Histórico', '#94A3B8', true);

  insert into public.memberships (user_id, organization_id, role, is_active)
  values (v_historic_uid, v_org_id, 'vendedor', false);

  -- Paleta diversificada (lote polish M6 ronda 2 — #8).
  insert into public.pipeline_stages
    (organization_id, funnel, name, position, color, default_probability,
     is_initial, is_won, is_lost, requires_loss_reason)
  values
    (v_org_id, 'venta', 'Lead nuevo',              1, '#94A3B8',  10.00, true,  false, false, false),
    (v_org_id, 'venta', 'Contactado asesor',       2, '#06B6D4',  20.00, false, false, false, false),
    (v_org_id, 'venta', 'Contacto calificado',     3, '#0EA5E9',  30.00, false, false, false, false),
    (v_org_id, 'venta', 'Reunión agendada',        4, '#8B5CF6',  45.00, false, false, false, false),
    (v_org_id, 'venta', 'Diseño de espacios',      5, '#EC4899',  55.00, false, false, false, false),
    (v_org_id, 'venta', 'Cotización',              6, '#F59E0B',  70.00, false, false, false, false),
    (v_org_id, 'venta', 'Seguimiento para cierre', 7, '#F97316',  85.00, false, false, false, false),
    (v_org_id, 'venta', 'Ganada',                  8, '#10B981', 100.00, false, true,  false, false),
    (v_org_id, 'venta', 'Perdida',                 9, '#EF4444',   0.00, false, false, true,  true);

  insert into public.pipeline_stages
    (organization_id, funnel, name, position, color, is_initial)
  values
    (v_org_id, 'post_venta', 'Pago confirmado',          1, '#14B8A6', true),
    (v_org_id, 'post_venta', 'Preparación / Envío',      2, '#6366F1', false),
    (v_org_id, 'post_venta', 'Entregado',                3, '#10B981', false),
    (v_org_id, 'post_venta', 'Seguimiento post-entrega', 4, '#D946EF', false),
    (v_org_id, 'post_venta', 'Cliente activo',           5, '#F59E0B', false),
    (v_org_id, 'post_venta', 'Caso problemático',        6, '#EF4444', false);

  insert into public.loss_reasons (organization_id, name) values
    (v_org_id, 'Precio'),
    (v_org_id, 'Tiempo'),
    (v_org_id, 'Competencia'),
    (v_org_id, 'Ghosting'),
    (v_org_id, 'Otro');

  return v_org_id;
end;
$$;
