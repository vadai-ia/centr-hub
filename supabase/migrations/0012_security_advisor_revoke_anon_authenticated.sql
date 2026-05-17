-- ============================================================
-- M2 · 0012 — Security Advisor: REVOKE explícito de anon/authenticated
-- ============================================================
-- Cierra los 6 warnings residuales tras 0011 + fix manual del operador.
--
-- Causa raíz del fix incompleto de 0011 + fix manual del operador:
-- Supabase configura por defecto `ALTER DEFAULT PRIVILEGES IN SCHEMA
-- public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated`. Estos
-- grants son SEPARADOS del grant a PUBLIC — `REVOKE FROM PUBLIC` NO
-- los toca. PostgREST sigue exponiendo la función como RPC porque
-- anon/authenticated retienen EXECUTE vía sus grants explícitos.
--
-- Fix correcto: REVOKE explícito de PUBLIC, anon, authenticated;
-- luego GRANT a los roles que realmente necesitan invocar la función.
--
-- Todas las sentencias son idempotentes.
-- ============================================================

-- ------------------------------------------------------------
-- bootstrap_organization: solo service_role
-- (admin/bootstrap nunca debe ser invocable desde sesión de usuario)
-- ------------------------------------------------------------
revoke execute on function public.bootstrap_organization(text, citext, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.bootstrap_organization(text, citext, text, text, text)
  to service_role;

-- ------------------------------------------------------------
-- rls_auto_enable: solo service_role
-- Función no definida en migraciones propias (Supabase la creó en el
-- proyecto remoto, posiblemente desde template o extension). Como no
-- conocemos la(s) signature(s), recorremos pg_proc para aplicar el
-- REVOKE/GRANT a todas las sobrecargas existentes en `public`.
-- Si no existe, el loop es no-op (idempotente y safe).
-- ------------------------------------------------------------
do $$
declare
  v_args text;
begin
  for v_args in
    select pg_get_function_identity_arguments(p.oid)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'rls_auto_enable'
  loop
    execute format(
      'revoke execute on function public.rls_auto_enable(%s) from public, anon, authenticated;',
      v_args
    );
    execute format(
      'grant execute on function public.rls_auto_enable(%s) to service_role;',
      v_args
    );
  end loop;
end;
$$;

-- ------------------------------------------------------------
-- is_member_of: warning intencional — anon y authenticated DEBEN
-- conservar EXECUTE para que las RLS policies que la invocan no
-- fallen con "permission denied for function".
--
-- Alternativas evaluadas y descartadas:
--   (a) SECURITY INVOKER → exigiría grants directos en tabla
--       `memberships` para anon/authenticated, exponiendo data
--       de membresías a roles que no deberían leerla directamente.
--   (b) Mover a schema `private` y renombrar referencias en
--       policies → invasivo, requiere drop + recreate de 16 policies
--       de tenant + 3 policies puntuales en organizations/memberships/
--       user_profiles. Riesgo alto para ganancia cosmética (silenciar
--       un warning del Advisor) cuando la exposición real está
--       contenida: la función solo retorna boolean y consulta una
--       tabla con RLS propia.
--
-- Decisión: mantener SECURITY DEFINER + EXECUTE para anon/authenticated.
-- Security Advisor seguirá reportando "callable by anon/authenticated"
-- — warning conscientemente ignorado, documentado en CLAUDE.md
-- (sección "Deuda técnica aceptada") y en ERRORES.md.
--
-- Re-aplicamos los grants explícitos aquí para que este archivo sea
-- el registro canónico de la política de acceso final.
-- ------------------------------------------------------------
revoke execute on function public.is_member_of(uuid) from public;
grant  execute on function public.is_member_of(uuid) to anon, authenticated, service_role;
