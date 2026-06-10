-- ============================================================
-- 0028 — Reparación de filas auth.users insertadas por SQL crudo
-- (M9.2, Block 2). NO destructivo, idempotente.
-- ============================================================
--
-- CONTEXTO
-- Los asesores reales Gina y Pepe (y el usuario sistema "Histórico",
-- sembrado en 0010) tienen filas en auth.users insertadas por SQL crudo
-- — no por el flujo de GoTrue. Esas filas dejan NULL varias columnas de
-- token que GoTrue escanea como TEXT NOT-NULL al cargar un usuario. El
-- síntoma es "Database error loading user" / "Database error finding
-- users" en `auth.admin.getUserById` / `listUsers` (confirmado en el
-- diagnóstico Block 0). Mientras la fila no sea legible por GoTrue NO se
-- puede `updateUserById` para fijarle un email real ni enviar el link de
-- contraseña — bloquea el "vincular login" de M9.2.
--
-- DECISIÓN (M9.2): repair-in-place. Se NORMALIZAN las columnas de token a
-- '' (cadena vacía, lo que GoTrue espera) SIN tocar el `id` del usuario.
-- Como `assigned_advisor_id` de opps/contactos/órdenes apunta a
-- `memberships.id` (estable) y `memberships.user_id` no cambia, las
-- atribuciones existentes (Gina: 29 opps activas/66 órdenes; Pepe: 5/34)
-- quedan intactas. NO se crea un asesor nuevo ni se re-apunta nada.
--
-- Dos piezas:
--   (A) Repair one-shot de las filas existentes con tokens NULL.
--   (B) RPC `repair_auth_user_tokens(uuid)` para reparar bajo demanda una
--       fila puntual justo antes de vincularle el login (el server action
--       de M9.2 la invoca). SECURITY DEFINER (corre como owner = postgres,
--       que puede escribir auth.users), EXECUTE solo para service_role.
--
-- Ambas son dinámicas: solo tocan columnas que EXISTAN en este esquema de
-- auth (defensa ante drift de versión de GoTrue).

-- ----- (A) Repair one-shot de filas existentes -----
do $$
declare
  col text;
  cols text[] := array[
    'confirmation_token',
    'recovery_token',
    'email_change',
    'email_change_token_new',
    'email_change_token_current',
    'phone_change',
    'phone_change_token',
    'reauthentication_token'
  ];
begin
  foreach col in array cols loop
    if exists (
      select 1 from information_schema.columns
       where table_schema = 'auth' and table_name = 'users' and column_name = col
    ) then
      execute format(
        'update auth.users set %1$I = coalesce(%1$I, '''') where %1$I is null',
        col
      );
    end if;
  end loop;
end $$;

-- ----- (B) RPC de reparación bajo demanda -----
create or replace function public.repair_auth_user_tokens(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = auth, public
as $$
declare
  col text;
  cols text[] := array[
    'confirmation_token',
    'recovery_token',
    'email_change',
    'email_change_token_new',
    'email_change_token_current',
    'phone_change',
    'phone_change_token',
    'reauthentication_token'
  ];
begin
  foreach col in array cols loop
    if exists (
      select 1 from information_schema.columns
       where table_schema = 'auth' and table_name = 'users' and column_name = col
    ) then
      execute format(
        'update auth.users set %1$I = coalesce(%1$I, '''') where id = $1 and %1$I is null',
        col
      ) using p_user_id;
    end if;
  end loop;
end $$;

revoke all on function public.repair_auth_user_tokens(uuid) from public, anon, authenticated;
grant execute on function public.repair_auth_user_tokens(uuid) to service_role;

comment on function public.repair_auth_user_tokens(uuid) is
  'M9.2: normaliza a '''' las columnas de token NULL de una fila auth.users insertada por SQL crudo, para que GoTrue pueda cargarla y se le pueda vincular un login. No toca el id (atribuciones intactas).';
