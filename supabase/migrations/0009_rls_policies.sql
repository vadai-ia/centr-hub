-- ============================================================
-- M1 · 0009 — RLS policies (Barrera 1 — Sección 3.7)
-- ============================================================
-- Toda tabla con organization_id habilita RLS y filtra por
-- public.current_organization_id() — que resuelve desde:
--   (a) setting de sesión 'app.current_organization_id' (server-side
--       wrapper, Barrera 2), o
--   (b) claim 'organization_id' del JWT (sesión usuario).
--
-- service_role bypassea RLS por construcción — por eso la
-- Barrera 2 (wrapper TypeScript) es obligatoria para workers
-- y rutinas server-side que usen service_role_key.
--
-- Las políticas se nombran <tabla>_tenant_<operación> para
-- mantener consistencia y debugging directo desde pg_policies.
-- ============================================================

-- ------------------------------------------------------------
-- organizations — política especial: el usuario solo ve sus orgs
-- ------------------------------------------------------------
alter table public.organizations enable row level security;

create policy organizations_select_member
  on public.organizations
  for select
  using (public.is_member_of(id));

-- Inserts/updates/deletes en organizations los hace el wrapper
-- administrativo (service_role) — sin policy de usuario.

-- ------------------------------------------------------------
-- user_profiles — un usuario solo ve su propio perfil y los
-- perfiles de miembros de sus organizaciones.
-- ------------------------------------------------------------
alter table public.user_profiles enable row level security;

create policy user_profiles_select_self_or_org_member
  on public.user_profiles
  for select
  using (
    id = auth.uid()
    or exists (
      select 1
        from public.memberships m_self
        join public.memberships m_other
          on m_other.organization_id = m_self.organization_id
       where m_self.user_id = auth.uid()
         and m_self.is_active = true
         and m_other.user_id = public.user_profiles.id
    )
  );

create policy user_profiles_update_self
  on public.user_profiles
  for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- ------------------------------------------------------------
-- memberships — el usuario ve solo sus membresías; admin de org
-- ve las de su org (verificación en aplicación; aquí RLS solo
-- protege contra acceso cruzado).
-- ------------------------------------------------------------
alter table public.memberships enable row level security;

create policy memberships_select_own_or_same_org
  on public.memberships
  for select
  using (
    user_id = auth.uid()
    or public.is_member_of(organization_id)
  );

-- ============================================================
-- Macro de tenant policies para tablas con organization_id
-- ============================================================
-- Crea las 4 policies estándar (select / insert / update / delete)
-- en cada tabla operativa. Misma forma para todas: filtrar por
-- current_organization_id().
-- ============================================================

do $$
declare
  v_table text;
  v_tenant_tables text[] := array[
    'contacts',
    'pipeline_stages',
    'loss_reasons',
    'opportunities',
    'opportunity_line_items',
    'opportunity_stage_history',
    'orders',
    'order_line_items',
    'automation_rules',
    'rule_executions',
    'activities',
    'tasks',
    'notifications',
    'audit_log',
    'goals',
    'tag_mappings'
  ];
begin
  foreach v_table in array v_tenant_tables loop
    execute format('alter table public.%I enable row level security;', v_table);

    execute format(
      'create policy %I on public.%I
         for select
         using (organization_id = public.current_organization_id());',
      v_table || '_tenant_select', v_table
    );

    execute format(
      'create policy %I on public.%I
         for insert
         with check (organization_id = public.current_organization_id());',
      v_table || '_tenant_insert', v_table
    );

    execute format(
      'create policy %I on public.%I
         for update
         using (organization_id = public.current_organization_id())
         with check (organization_id = public.current_organization_id());',
      v_table || '_tenant_update', v_table
    );

    execute format(
      'create policy %I on public.%I
         for delete
         using (organization_id = public.current_organization_id());',
      v_table || '_tenant_delete', v_table
    );
  end loop;
end;
$$;

-- ============================================================
-- Tablas inmutables (audit trail): bloquear delete/update vía
-- trigger ya cubre eso, pero anulamos las policies de update/delete
-- a nivel RLS también para coherencia. Las policies de SELECT/INSERT
-- creadas arriba se mantienen.
-- ============================================================
-- (Nada que hacer: las policies de update/delete creadas arriba
-- igual fallan porque el trigger tg_block_mutation se dispara
-- antes de retornar. RLS + trigger = doble barrera.)
