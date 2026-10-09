-- ============================================================
-- 0057 — Presencia y sesiones de uso ("¿estuvo conectado?")
-- ============================================================
-- Lo que se pidió es deliberadamente angosto: saber si una persona está
-- usando la plataforma AHORA y tener un historial corto de "estuvo conectado
-- de tal hora a tal hora, tal día". NO es auditoría de acciones (eso ya lo
-- cubre `audit_log`) ni telemetría de pantallas.
--
-- Modelo: UNA fila por tramo de uso continuo. El navegador late cada pocos
-- minutos; el latido EXTIENDE el tramo vigente (`last_seen_at`) y solo abre
-- uno nuevo cuando pasó más de `p_gap_minutes` sin señal. Así no hay que
-- detectar el "logout" —que nunca llega de forma fiable: la gente cierra la
-- pestaña, se le duerme el equipo, se cae la red— y el final del tramo es
-- simplemente su último latido.
--
-- Una fila por tramo, no por latido: en un día de trabajo normal esto son
-- una o dos filas por persona, no cientos.
-- ============================================================

create table if not exists public.user_activity_sessions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.user_profiles(id) on delete cascade,
  -- Inicio del tramo. No se vuelve a tocar nunca.
  started_at      timestamptz not null default now(),
  -- Último latido recibido. Es también el FIN del tramo: no existe un
  -- `ended_at` porque no hay evento fiable de cierre de sesión.
  last_seen_at    timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

comment on table public.user_activity_sessions is
  'Un tramo de uso continuo por persona y organización (0057). El latido del '
  'navegador extiende last_seen_at; un hueco mayor al gap abre un tramo nuevo. '
  'NO es auditoría de acciones (audit_log) — solo "estuvo conectado de X a Y".';
comment on column public.user_activity_sessions.last_seen_at is
  'Último latido = fin del tramo. No hay ended_at: cerrar la pestaña, dormir '
  'el equipo o perder la red no emiten ningún evento.';

-- Sirve a las dos lecturas: el último tramo de una persona (presencia) y su
-- historial reciente, ambos por (org, persona) y ordenados por fin del tramo.
create index if not exists user_activity_sessions_org_user_idx
  on public.user_activity_sessions (organization_id, user_id, last_seen_at desc);

-- RLS: las 4 tenant policies estándar (macro de 0009 / 0031 / 0038).
alter table public.user_activity_sessions enable row level security;

create policy user_activity_sessions_tenant_select on public.user_activity_sessions
  for select using (organization_id = public.current_organization_id());

create policy user_activity_sessions_tenant_insert on public.user_activity_sessions
  for insert with check (organization_id = public.current_organization_id());

create policy user_activity_sessions_tenant_update on public.user_activity_sessions
  for update using (organization_id = public.current_organization_id())
  with check (organization_id = public.current_organization_id());

create policy user_activity_sessions_tenant_delete on public.user_activity_sessions
  for delete using (organization_id = public.current_organization_id());


-- ------------------------------------------------------------
-- record_user_presence — el latido, ATÓMICO
-- ------------------------------------------------------------
-- "Buscar el tramo vigente y, si no hay, crearlo" es leer-y-luego-escribir:
-- dos pestañas de la misma persona laten a la vez, ambas ven que no hay tramo
-- y nacen dos. El historial mostraría entonces dos conexiones simultáneas
-- para una sola. El lock de transacción por (org, persona) lo cierra; no se
-- puede resolver con un índice único porque la unicidad depende del TIEMPO
-- (hay varios tramos legítimos por persona y día).
create or replace function public.record_user_presence(
  p_organization_id uuid,
  p_user_id         uuid,
  p_gap_minutes     integer default 10
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_gap_minutes is null or p_gap_minutes < 1 then
    raise exception 'record_user_presence: p_gap_minutes debe ser >= 1';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_organization_id::text || ':' || p_user_id::text, 0)
  );

  select id
    into v_id
    from public.user_activity_sessions
   where organization_id = p_organization_id
     and user_id = p_user_id
     and last_seen_at >= now() - make_interval(mins => p_gap_minutes)
   order by last_seen_at desc
   limit 1;

  if v_id is null then
    insert into public.user_activity_sessions (organization_id, user_id)
    values (p_organization_id, p_user_id)
    returning id into v_id;
  else
    update public.user_activity_sessions
       set last_seen_at = now()
     where id = v_id;
  end if;

  return v_id;
end;
$$;

comment on function public.record_user_presence(uuid, uuid, integer) is
  'Latido de presencia (0057): extiende el tramo vigente o abre uno nuevo si '
  'el hueco supera p_gap_minutes. Atómico bajo lock por (org, persona) — sin '
  'él, dos pestañas abren dos tramos para la misma sesión.';

-- No es una RPC pública: la invoca el data layer con service_role.
revoke all on function public.record_user_presence(uuid, uuid, integer) from public;
grant execute on function public.record_user_presence(uuid, uuid, integer) to service_role;
