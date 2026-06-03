-- ============================================================
-- M7.2 · 0020 — Trigger atómico F1 → F2 (RPC Postgres)
-- ============================================================
-- Cuando un Draft Order de Shopify se COMPLETA, la oportunidad F1
-- (Funnel Venta) ligada pasa a Ganada y nace atómicamente su
-- oportunidad hija en el Funnel Post-venta, en la etapa inicial
-- "Cotización completada".
--
-- MECANISMO DE ATOMICIDAD ELEGIDO: función PL/pgSQL invocada como
-- RPC única. Una función sin bloque EXCEPTION corre dentro de la
-- transacción del statement que la invoca; si cualquier paso falla
-- (constraint, etc.), Postgres aborta y revierte TODO — no existe
-- estado intermedio posible (F1 ganada sin hija, hija sin parent).
-- Esto es atomicidad real garantizada por el motor, superior al
-- compensating-revert en aplicación (que deja huecos si el proceso
-- muere entre pasos). Es además consistente con `bootstrap_organization`.
--
-- IDEMPOTENCIA: si ya existe una hija post-venta para la F1, retorna
-- 'skipped'/'child_exists' sin tocar nada. Una completación duplicada
-- (webhook repetido) nunca crea una segunda hija.
--
-- PRE-CONDICIONES (si fallan → 'skipped' + razón, el worker sigue
-- procesando el webhook normalmente, NO se dispara el trigger):
--   - La F1 existe.
--   - F1 es de Funnel Venta y `parent_opportunity_id` es NULL.
--   - El Funnel Post-venta de la org tiene etapa con is_initial=true.
--   - El Funnel Venta tiene etapa con is_won=true.
--
-- R2 (asignación de origen): la hija HEREDA `assigned_advisor_id` de
-- la F1 en el momento del trigger. Una reasignación posterior del
-- admin sobre la F1 NO se propaga a la hija (cada entidad mantiene
-- su asignación de origen). El RPC no vuelve a tocar la hija.
--
-- Resultado: jsonb { status, reason, child_opportunity_id }.
-- ============================================================

create or replace function public.trigger_f1_to_f2(
  p_opportunity_id  uuid,
  p_shopify_order_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_f1             public.opportunities%rowtype;
  v_won_stage      public.pipeline_stages%rowtype;
  v_initial_pv     public.pipeline_stages%rowtype;
  v_existing_child uuid;
  v_child_id       uuid;
  v_from_stage     uuid;
begin
  -- Lock pesimista sobre la F1: serializa completaciones concurrentes
  -- del mismo Draft Order (la segunda espera y ve la hija ya creada).
  select * into v_f1
    from public.opportunities
   where id = p_opportunity_id
   for update;
  if not found then
    return jsonb_build_object(
      'status', 'skipped', 'reason', 'f1_not_found', 'child_opportunity_id', null);
  end if;

  -- Pre-condición: F1 de Funnel Venta sin parent.
  if v_f1.funnel <> 'venta' or v_f1.parent_opportunity_id is not null then
    return jsonb_build_object(
      'status', 'skipped', 'reason', 'precondition_not_venta_parent',
      'child_opportunity_id', null);
  end if;

  -- Idempotencia: hija post-venta ya existente.
  select id into v_existing_child
    from public.opportunities
   where parent_opportunity_id = v_f1.id
     and funnel = 'post_venta'
   limit 1;
  if v_existing_child is not null then
    return jsonb_build_object(
      'status', 'skipped', 'reason', 'child_already_exists',
      'child_opportunity_id', v_existing_child);
  end if;

  -- Pre-condición: etapa inicial del Funnel Post-venta.
  select * into v_initial_pv
    from public.pipeline_stages
   where organization_id = v_f1.organization_id
     and funnel = 'post_venta'
     and is_initial = true
   limit 1;
  if not found then
    return jsonb_build_object(
      'status', 'skipped', 'reason', 'no_postventa_initial_stage',
      'child_opportunity_id', null);
  end if;

  -- Pre-condición: etapa Ganada del Funnel Venta.
  select * into v_won_stage
    from public.pipeline_stages
   where organization_id = v_f1.organization_id
     and funnel = 'venta'
     and is_won = true
   order by position asc
   limit 1;
  if not found then
    return jsonb_build_object(
      'status', 'skipped', 'reason', 'no_venta_won_stage',
      'child_opportunity_id', null);
  end if;

  v_from_stage := v_f1.stage_id;

  -- 1) F1 → Ganada + won_at + shopify_order_id (gap cerrado).
  --    coalesce preserva won_at/shopify_order_id si ya estaban (F1
  --    ganada manualmente antes de la completación del draft).
  update public.opportunities
     set stage_id             = v_won_stage.id,
         won_at               = coalesce(won_at, now()),
         shopify_order_id     = coalesce(shopify_order_id, p_shopify_order_id),
         last_modified_at     = now(),
         last_modified_source = 'platform'
   where id = v_f1.id;

  -- 2) Historial de etapa de la F1 — solo si hubo cambio real de etapa.
  if v_from_stage is distinct from v_won_stage.id then
    insert into public.opportunity_stage_history
      (organization_id, opportunity_id, from_stage_id, to_stage_id,
       changed_by_user_id, context)
    values
      (v_f1.organization_id, v_f1.id, v_from_stage, v_won_stage.id,
       null, 'trigger_f1_f2');
  end if;

  -- 3) Hija en Post-venta inicial, heredando contacto + asesor (R2).
  insert into public.opportunities
    (organization_id, funnel, stage_id, contact_id, assigned_advisor_id,
     parent_opportunity_id, currency, last_modified_at, last_modified_source)
  values
    (v_f1.organization_id, 'post_venta', v_initial_pv.id, v_f1.contact_id,
     v_f1.assigned_advisor_id, v_f1.id, v_f1.currency, now(), 'platform')
  returning id into v_child_id;

  -- 4) Historial de etapa de la hija (nacimiento).
  insert into public.opportunity_stage_history
    (organization_id, opportunity_id, from_stage_id, to_stage_id,
     changed_by_user_id, context)
  values
    (v_f1.organization_id, v_child_id, null, v_initial_pv.id,
     null, 'trigger_f1_f2');

  return jsonb_build_object(
    'status', 'fired', 'reason', null, 'child_opportunity_id', v_child_id);
end;
$$;

-- Solo el service_role (workers Inngest) invoca este RPC. No es una
-- RPC pública — revocar de public/anon/authenticated.
revoke execute on function public.trigger_f1_to_f2(uuid, text)
  from public, anon, authenticated;
grant  execute on function public.trigger_f1_to_f2(uuid, text)
  to service_role;
