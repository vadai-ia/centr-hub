-- ============================================================
-- M5-DT-01 · 0017 — Custom Access Token Hook (claim organization_id)
-- ============================================================
-- Inyecta el claim TOP-LEVEL `organization_id` en cada JWT emitido
-- por Supabase Auth. Sin este hook, current_organization_id() (mig.
-- 0001) devuelve NULL en sesiones de navegador, todas las RLS
-- policies tenant-aware se cierran, y Supabase Realtime descarta
-- silenciosamente cada evento postgres_changes hacia el browser.
--
-- Cierra la deuda documentada en ERRORES.md
-- ("Supabase Realtime no entrega eventos al browser sin claim
--  organization_id en el JWT") y en PENDIENTES.md (M5-DT-01).
--
-- Resolución de la organización activa (orden de precedencia):
--   1. `auth.users.raw_app_meta_data->>'active_organization_id'`,
--      escrito por switchOrganization() en lib/actions/auth.ts. Se
--      valida CONTRA `public.memberships` (debe ser una membership
--      activa del usuario) para descartar marcadores stale o
--      manipulados — defensa multi-tenant.
--   2. Fallback estable: membership activa más antigua del usuario
--      (`ORDER BY created_at ASC LIMIT 1`). Cubre single-org sin
--      escritura en app_metadata, y multi-org en primer login antes
--      de elegir org.
--   3. Sin membership activa → claims sin tocar. RLS bloquea, que
--      es el comportamiento correcto para un user "sin tenant".
--
-- El claim se emite en la RAÍZ del objeto claims (no dentro de
-- app_metadata), porque current_organization_id() lee con
-- `auth.jwt() ->> 'organization_id'` (mig. 0001 línea 59).
--
-- Step operativo POST-aplicación (no es código del repo):
--   Supabase Dashboard → Authentication → Hooks → "Customize Access
--   Token (JWT) Claims" → seleccionar `public.custom_access_token_hook`.
--   Sin ese paso la función existe pero NO se invoca al emitir JWT.
--   Documentado en CLAUDE.md sección "Hook de claim organization_id".
--
-- Permisos:
--   - EXECUTE sólo para `supabase_auth_admin` (el rol que invoca
--     GoTrue desde Supabase Auth). Revocado de public/anon/authenticated
--     porque NO es un endpoint público — no se llama como RPC.
--   - La función es SECURITY DEFINER, así que corre con privilegios
--     del owner (postgres en Supabase) y bypasea RLS de memberships
--     sin necesidad de grants adicionales sobre la tabla.
-- ============================================================

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_user_id          uuid;
  v_metadata_org_id  uuid;
  v_resolved_org_id  uuid;
  v_claims           jsonb;
begin
  v_user_id := nullif(event ->> 'user_id', '')::uuid;
  v_claims  := coalesce(event -> 'claims', '{}'::jsonb);

  if v_user_id is null then
    return event;
  end if;

  -- 1) Leer marcador desde auth.users.raw_app_meta_data.
  begin
    select nullif(raw_app_meta_data ->> 'active_organization_id', '')::uuid
      into v_metadata_org_id
      from auth.users
     where id = v_user_id;
  exception when others then
    v_metadata_org_id := null;
  end;

  -- 2) Validación defensiva: el marcador SÓLO se acepta si corresponde
  --    a una membership activa del usuario. Marcador stale (la
  --    membership fue desactivada) o manipulado (escritura admin
  --    indebida) cae al fallback.
  if v_metadata_org_id is not null then
    select m.organization_id
      into v_resolved_org_id
      from public.memberships m
     where m.user_id         = v_user_id
       and m.organization_id = v_metadata_org_id
       and m.is_active       = true
     limit 1;
  end if;

  -- 3) Fallback: primera membership activa por creación.
  if v_resolved_org_id is null then
    select m.organization_id
      into v_resolved_org_id
      from public.memberships m
     where m.user_id   = v_user_id
       and m.is_active = true
     order by m.created_at asc
     limit 1;
  end if;

  -- 4) Sin membership activa → claims sin modificar. RLS bloquea
  --    por evaluación contra NULL, comportamiento correcto.
  if v_resolved_org_id is null then
    return event;
  end if;

  -- 5) Merge top-level del claim. current_organization_id() lo lee
  --    con `auth.jwt() ->> 'organization_id'` (raíz, no app_metadata).
  v_claims := v_claims || jsonb_build_object(
    'organization_id', v_resolved_org_id::text
  );

  return jsonb_set(event, '{claims}', v_claims, true);
end;
$$;

comment on function public.custom_access_token_hook(jsonb) is
  'Supabase Auth Custom Access Token Hook — inyecta claim top-level organization_id en el JWT. Ver migración 0017 + CLAUDE.md "Hook de claim organization_id".';

-- ------------------------------------------------------------
-- Permisos: sólo el rol que invoca el hook desde GoTrue.
-- NO es un endpoint público (no se invoca como RPC desde el cliente).
-- ------------------------------------------------------------
revoke execute on function public.custom_access_token_hook(jsonb)
  from public, anon, authenticated;

grant execute on function public.custom_access_token_hook(jsonb)
  to supabase_auth_admin;

-- ------------------------------------------------------------
-- Validación inline: un user_id sintético sin memberships debe
-- devolver el event SIN inyectar claim. Cubre la regresión más
-- peligrosa (claim espurio para user sin tenant).
--
-- Los casos positivos (con membership) requieren fixtures de
-- auth.users + memberships, que no podemos crear desde una
-- migración limpia. Quedan cubiertos por la validación operativa
-- post-deploy documentada en CLAUDE.md.
-- ------------------------------------------------------------
do $$
declare
  v_unknown_uuid uuid := '00000000-0000-0000-0000-0000000000ff';
  v_event        jsonb;
  v_out          jsonb;
begin
  v_event := jsonb_build_object(
    'user_id', v_unknown_uuid::text,
    'claims', jsonb_build_object(
      'sub',  v_unknown_uuid::text,
      'role', 'authenticated'
    )
  );

  v_out := public.custom_access_token_hook(v_event);

  if (v_out -> 'claims') ? 'organization_id' then
    raise exception
      'custom_access_token_hook regression: claim organization_id inyectado para user sin membership (got %)',
      v_out;
  end if;

  if v_out is distinct from v_event then
    raise exception
      'custom_access_token_hook regression: event mutado para user sin membership (got %, expected %)',
      v_out, v_event;
  end if;
end;
$$;
