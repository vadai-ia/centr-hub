-- ============================================================
-- M1 · 0001 — Extensiones y helpers
-- ============================================================
-- Habilita extensiones necesarias y define el trigger reutilizable
-- de updated_at + el helper de tenant context para RLS.
-- ============================================================

create extension if not exists "pgcrypto";    -- gen_random_uuid()
create extension if not exists "citext";      -- emails / slugs case-insensitive

-- ------------------------------------------------------------
-- Trigger genérico: actualizar updated_at en cada UPDATE
-- ------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ------------------------------------------------------------
-- Helper: organización activa para RLS
--
-- Resolución por orden de precedencia:
--   1. Setting de sesión 'app.current_organization_id' (wrapper
--      explícito del lado del servidor — Barrera 2 de Sección 3.7).
--   2. Claim 'organization_id' del JWT (Barrera 1 — sesión de
--      usuario autenticado vía Supabase Auth).
--
-- Si ninguno está presente devuelve NULL — las políticas RLS
-- comparan contra organization_id de la fila, así que NULL
-- bloquea acceso (R6).
-- ------------------------------------------------------------
create or replace function public.current_organization_id()
returns uuid
language plpgsql
stable
as $$
declare
  v_session text;
  v_jwt     text;
begin
  -- 1) setting de sesión (set_config)
  begin
    v_session := current_setting('app.current_organization_id', true);
  exception when others then
    v_session := null;
  end;

  if v_session is not null and v_session <> '' then
    return v_session::uuid;
  end if;

  -- 2) claim del JWT
  begin
    v_jwt := nullif(auth.jwt() ->> 'organization_id', '');
  exception when others then
    v_jwt := null;
  end;

  if v_jwt is not null then
    return v_jwt::uuid;
  end if;

  return null;
end;
$$;

-- ------------------------------------------------------------
-- Helper: validar que existe contexto de tenant.
-- Lo usan rutinas SQL administrativas; el wrapper de aplicación
-- en TS también lanza error simétrico (defensa en profundidad).
-- ------------------------------------------------------------
create or replace function public.assert_organization_context()
returns uuid
language plpgsql
stable
as $$
declare
  v_org uuid := public.current_organization_id();
begin
  if v_org is null then
    raise exception 'tenant_context_required: no se puede operar sin organization_id'
      using errcode = 'P0001';
  end if;
  return v_org;
end;
$$;
