-- ============================================================
-- M2 · 0011 — Security Advisor: search_path + SECURITY DEFINER
-- ============================================================
-- Cierra 12 warnings de Supabase Security Advisor detectados
-- tras M1+M2. Todas las sentencias son idempotentes.
--
-- Grupos:
--   1. search_path mutable — 4 funciones sin SET search_path
--   2. SECURITY DEFINER callable externally — REVOKE/GRANT en
--      is_member_of y bootstrap_organization
--
-- Grupos no incluidos aquí (deuda documentada en CLAUDE.md):
--   3. citext en public schema — aceptado para MVP
--   4. Leaked Password Protection — requiere Supabase Pro
-- ============================================================

-- ------------------------------------------------------------
-- Grupo 1 — search_path mutable
-- Fija el schema de resolución para prevenir search_path injection.
-- ------------------------------------------------------------
alter function public.tg_set_updated_at()         set search_path = public;
alter function public.current_organization_id()    set search_path = public;
alter function public.assert_organization_context() set search_path = public;
alter function public.tg_block_mutation()          set search_path = public;

-- ------------------------------------------------------------
-- Grupo 2 — SECURITY DEFINER callable externally
-- PostgREST expone como RPC toda función con EXECUTE en PUBLIC.
-- REVOKE elimina la exposición; GRANT la restaura solo a los
-- roles que necesitan invocarla.
-- ------------------------------------------------------------

-- is_member_of(uuid): usada en RLS — anon y authenticated la
-- necesitan para que las policies no fallen con "permission denied".
revoke execute on function public.is_member_of(uuid) from public;
grant  execute on function public.is_member_of(uuid) to anon, authenticated;

-- bootstrap_organization: solo invocable desde service_role.
-- Ya aplicado en 0010; se re-aplica aquí para que este archivo
-- sea el registro canónico de la política de acceso.
revoke execute on function public.bootstrap_organization(text, citext, text, text, text) from public;
grant  execute on function public.bootstrap_organization(text, citext, text, text, text) to service_role;

-- rls_auto_enable: no definida en migraciones propias.
-- Security Advisor la reporta como función Supabase-interna;
-- no requiere acción en migraciones custom (ver ERRORES.md).
