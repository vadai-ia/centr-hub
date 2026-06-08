-- ============================================================
-- Fix post-M7.2 · 0023 — La oportunidad de Venta hereda el asesor de
-- su PEDIDO cuando está SIN asesor (rellena NULL, nunca pisa)
-- ============================================================
-- PROBLEMA corregido (análogo a 0022, pero sobre la F1 de Venta en vez
-- de la hija de Post-venta): una oportunidad de Funnel Venta puede
-- quedar con `assigned_advisor_id` NULL aunque su pedido (order) SÍ
-- tenga asesor atribuido por tag de vendedor. Pasa por la ventana de
-- carrera: la opp de Venta se crea/avanza por la tag del Draft Order,
-- pero la tag de vendedor se agrega al PEDIDO después, vía un webhook
-- `orders/*` independiente y sin orden garantizado. Resultado: el
-- pedido es de un vendedor pero su opp de Venta queda sin asignar — el
-- admin no ve el trabajo de ese asesor en el pipeline de Venta.
-- Caso real: 3 opps de Venta en "Ganada" con asesor NULL cuyo pedido
-- tiene tag "Pepe" (c092874e-..., cb1c6a05-..., 251bc26c-...). Son las
-- F1 madre de las 3 hijas de Post-venta ya corregidas por 0022.
--
-- DECISIÓN DE NEGOCIO (operador):
--   - La opp de Venta hereda el asesor del pedido SOLO si la opp está
--     SIN asesor (NULL). Si YA tiene asesor, NO se pisa — se respeta la
--     atribución previa por tag de draft (R2) o manual. Esto rellena los
--     huecos sin borrar trabajo legítimo de otro asesor.
--   - Aplica en CUALQUIER etapa del Funnel Venta (no solo Ganada): el
--     admin quiere ver el trabajo del asesor en todas las etapas.
--
-- DIFERENCIA CLAVE CON 0022: la re-atribución de la hija de Post-venta
-- (0022) SÍ pisa el asesor de la hija con el de la orden (decisión:
-- quien cierra atiende post-venta). Aquí, en cambio, la regla es
-- estrictamente "rellenar NULL" — NUNCA sobrescribir. Por eso esta RPC
-- NO necesita la guarda anti-reasignación-manual de 0022: cualquier
-- valor no-NULL (puesto por tag de draft o manual) queda intacto por
-- definición, así que la atribución manual nunca se pisa.
--
-- ESTE FIX:
--   1) reattribute_venta_opportunity_advisor: RPC nueva, doble uso —
--      (a) correctivo de opps de Venta ya existentes (script de
--          mantenimiento), reusando la misma semántica;
--      (b) hook de orders/* que cierra la ventana de carrera de forma
--          permanente (extiende el hook que 0022 ya usa para la hija).
--
-- R2 (independencia): solo toca el asesor de la OPP de Venta. Nunca
-- escribe a la orden ni al contacto.
--
-- COEXISTENCIA CON 0022 EN EL MISMO EVENTO DE ORDEN: el hook de orders/*
-- invoca ambas RPC sobre la misma `order.opportunity_id`. No colisionan
-- ni duplican trabajo: esta RPC toca SOLO la fila funnel='venta' (la F1)
-- y reattribute_postventa_child_advisor toca SOLO la fila
-- funnel='post_venta' (la hija). Filas distintas, funnels distintos.
-- ============================================================

create or replace function public.reattribute_venta_opportunity_advisor(
  p_opportunity_id uuid,
  p_dry_run        boolean default false,
  p_source         text default 'reattribution'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_opp           public.opportunities%rowtype;
  v_order_advisor uuid;
  v_order_id      text;
  v_to            uuid;
begin
  -- Lock pesimista: serializa el hook de orders/* contra el correctivo
  -- y contra completaciones concurrentes del mismo pedido.
  select * into v_opp
    from public.opportunities
   where id = p_opportunity_id
   for update;
  if not found then
    return jsonb_build_object(
      'status', 'skipped', 'reason', 'opportunity_not_found',
      'opportunity_id', p_opportunity_id);
  end if;

  -- Solo aplica a oportunidades de Funnel Venta.
  if v_opp.funnel <> 'venta' then
    return jsonb_build_object(
      'status', 'skipped', 'reason', 'not_venta_opportunity',
      'opportunity_id', v_opp.id);
  end if;

  -- GUARDRAIL CENTRAL: solo rellena NULL. Si la opp YA tiene asesor
  -- (por tag de draft, herencia o manual), no se toca — NUNCA se pisa.
  -- Esto también hace idempotente la RPC: tras rellenar, el segundo
  -- run cae aquí. Y subsume la protección anti-manual: cualquier valor
  -- no-NULL queda intacto por definición.
  if v_opp.assigned_advisor_id is not null then
    return jsonb_build_object(
      'status', 'skipped', 'reason', 'opportunity_already_assigned',
      'opportunity_id', v_opp.id,
      'advisor_id', v_opp.assigned_advisor_id);
  end if;

  -- Resolver el asesor del pedido vinculado. Canónico: el pedido que
  -- referencia esta opp (orders.opportunity_id, seteado al crear la
  -- orden desde el Draft Order). Fallback: por shopify_order_id que la
  -- opp espeja (poblado por el trigger F1→F2 al ganar). Solo nos
  -- interesan pedidos CON asesor.
  v_order_advisor := null;
  v_order_id      := null;

  select assigned_advisor_id, shopify_order_id
    into v_order_advisor, v_order_id
    from public.orders
   where organization_id = v_opp.organization_id
     and opportunity_id = v_opp.id
     and assigned_advisor_id is not null
   order by created_at asc
   limit 1;

  if v_order_advisor is null and v_opp.shopify_order_id is not null then
    select assigned_advisor_id, shopify_order_id
      into v_order_advisor, v_order_id
      from public.orders
     where organization_id = v_opp.organization_id
       and shopify_order_id = v_opp.shopify_order_id
       and assigned_advisor_id is not null
     limit 1;
  end if;

  -- Sin pedido con asesor → nada que heredar. La opp sigue sin asesor
  -- (estado correcto hasta que el pedido aterrice con su tag).
  if v_order_advisor is null then
    return jsonb_build_object(
      'status', 'noop', 'reason', 'order_has_no_advisor',
      'opportunity_id', v_opp.id);
  end if;

  v_to := v_order_advisor;

  -- Dry-run: reportar sin escribir (from siempre NULL — solo rellenamos
  -- huecos).
  if p_dry_run then
    return jsonb_build_object(
      'status', 'would_fix',
      'opportunity_id', v_opp.id,
      'order_shopify_order_id', v_order_id,
      'from_advisor_id', null,
      'to_advisor_id', v_to);
  end if;

  update public.opportunities
     set assigned_advisor_id = v_to,
         last_modified_at     = now(),
         last_modified_source = 'platform'
   where id = v_opp.id;

  insert into public.audit_log
    (organization_id, actor_user_id, event_type, entity_type, entity_id, payload)
  values
    (v_opp.organization_id, null, 'venta_opportunity_advisor_reattributed',
     'opportunity', v_opp.id,
     jsonb_build_object(
       'order_shopify_order_id', v_order_id,
       'from_advisor_id', null,
       'to_advisor_id', v_to,
       'source', p_source));

  return jsonb_build_object(
    'status', 'fixed',
    'opportunity_id', v_opp.id,
    'order_shopify_order_id', v_order_id,
    'from_advisor_id', null,
    'to_advisor_id', v_to);
end;
$$;

revoke execute on function public.reattribute_venta_opportunity_advisor(uuid, boolean, text)
  from public, anon, authenticated;
grant  execute on function public.reattribute_venta_opportunity_advisor(uuid, boolean, text)
  to service_role;
