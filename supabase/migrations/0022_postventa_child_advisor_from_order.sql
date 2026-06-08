-- ============================================================
-- Fix M7.2 · 0022 — La hija de Post-venta hereda el asesor de la
-- ORDEN cerrada (fallback: asesor de la F1 madre)
-- ============================================================
-- PROBLEMA corregido: el trigger 0020/0021 copiaba `assigned_advisor_id`
-- de la F1 a la hija. Pero la F1 muchas veces está SIN asignar (NULL),
-- mientras que la ORDEN sí queda atribuida al vendedor (vía parser de
-- tags). Resultado: el dashboard cuenta el pedido para el vendedor
-- (mira el asesor de la orden) pero el pipeline de Post-venta filtrado
-- por ese vendedor no muestra nada (mira el asesor de la opp).
-- Caso real: order 7070657282324, tag "Pepe", asesor de orden = Pepe,
-- pero la hija de Post-venta con asesor NULL.
--
-- DECISIÓN DE NEGOCIO (operador): la hija hereda el asesor de la ORDEN
-- cuando la orden tiene asesor (quien cerró la venta según la tag
-- atiende el post-venta — espíritu de R2: la fuente de atribución del
-- post-venta es la orden cerrada, no la negociación previa). Solo si la
-- orden NO tiene asesor cae al asesor de la F1 (fallback = comportamiento
-- 0020/0021). NUNCA propaga hacia atrás: no toca el asesor de la F1 ni
-- del contacto.
--
-- ESTE FIX:
--   1) trigger_f1_to_f2: al crear la hija, resuelve el asesor con
--      coalesce(asesor_de_la_orden, asesor_de_la_F1). La orden se
--      resuelve por `shopify_order_id` (el mismo valor que la hija
--      espeja). Si la orden aún no aterrizó en BD (carrera de webhooks
--      draft_orders/* vs orders/*), el asesor de orden es NULL → cae al
--      fallback F1; el hook de orders/* (ver lib/inngest/functions/orders.ts)
--      lo re-atribuye cuando la orden con asesor llega después.
--   2) reattribute_postventa_child_advisor: RPC nueva, doble uso —
--      (a) correctivo de hijas ya existentes (script de mantenimiento),
--      (b) hook de orders/* que cierra la ventana de carrera de forma
--      permanente. Misma semántica que el trigger arreglado.
--
-- ATOMICIDAD / IDEMPOTENCIA del trigger: se preservan — la resolución
-- del asesor es un SELECT extra dentro del mismo RPC sin EXCEPTION; el
-- guard child_already_exists sigue garantizando una sola hija.
--
-- R2 (sin propagación a la hija después del nacimiento): el trigger
-- sigue tocando la hija UNA sola vez. Reasignaciones posteriores de la
-- F1 no se propagan. La re-atribución posterior la dispara la ORDEN
-- (no la F1), y solo cuando la orden tiene asesor.
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
  v_child_order_id text;
  v_order_advisor  uuid;
  v_child_advisor  uuid;
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
  -- Order id efectivo de la venta: el que la F1 ya tenía, o el que
  -- llega con esta completación. La hija espeja exactamente el mismo
  -- valor que la F1 queda con (coalesce en el UPDATE de abajo).
  v_child_order_id := coalesce(v_f1.shopify_order_id, p_shopify_order_id);

  -- Asesor de la hija: el de la ORDEN cerrada cuando la orden tiene
  -- asesor; si no, el de la F1 (fallback). La orden se resuelve por
  -- shopify_order_id (unique por org → ≤1 fila). Si la orden todavía no
  -- aterrizó (carrera de webhooks), v_order_advisor queda NULL y el
  -- coalesce cae a la F1; el hook de orders/* lo corrige al llegar.
  v_order_advisor := null;
  if v_child_order_id is not null then
    select assigned_advisor_id into v_order_advisor
      from public.orders
     where organization_id = v_f1.organization_id
       and shopify_order_id = v_child_order_id
     limit 1;
  end if;
  v_child_advisor := coalesce(v_order_advisor, v_f1.assigned_advisor_id);

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

  -- 3) Hija en Post-venta inicial. Hereda contacto + asesor de la ORDEN
  --    (fallback F1) + datos comerciales de la F1 (monto real/estimado,
  --    order_id y referencia visible). NO hereda shopify_draft_order_id
  --    (ver cabecera de 0021: unique constraint + maybeSingle del lookup).
  insert into public.opportunities
    (organization_id, funnel, stage_id, contact_id, assigned_advisor_id,
     parent_opportunity_id, currency,
     actual_amount, estimated_amount, shopify_order_id, display_reference,
     last_modified_at, last_modified_source)
  values
    (v_f1.organization_id, 'post_venta', v_initial_pv.id, v_f1.contact_id,
     v_child_advisor, v_f1.id, v_f1.currency,
     v_f1.actual_amount, v_f1.estimated_amount, v_child_order_id,
     v_f1.display_reference,
     now(), 'platform')
  returning id into v_child_id;

  -- 3b) Line items — copia 1:1 desde la F1 a la hija, dentro del
  --     mismo RPC (atómico). Solo en el nacimiento de la hija, así
  --     que no hay riesgo de duplicado por idempotencia.
  insert into public.opportunity_line_items
    (organization_id, opportunity_id, shopify_product_id, shopify_variant_id,
     title, sku, quantity, variant_title, original_unit_price,
     discount_amount, final_price, weight_grams, taxable)
  select organization_id, v_child_id, shopify_product_id, shopify_variant_id,
     title, sku, quantity, variant_title, original_unit_price,
     discount_amount, final_price, weight_grams, taxable
    from public.opportunity_line_items
   where opportunity_id = v_f1.id;

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

revoke execute on function public.trigger_f1_to_f2(uuid, text)
  from public, anon, authenticated;
grant  execute on function public.trigger_f1_to_f2(uuid, text)
  to service_role;


-- ============================================================
-- reattribute_postventa_child_advisor — re-atribución del asesor
-- ============================================================
-- Alinea el asesor de una hija de Post-venta YA existente con el de su
-- ORDEN cerrada, reusando la MISMA semántica que el trigger arreglado.
-- Doble uso:
--   (a) Correctivo de hijas pre-fix (script de mantenimiento) — las
--       hijas que heredaron NULL/asesor-de-F1 toman el asesor de la
--       orden cuando corresponde.
--   (b) Hook en el worker de orders/* — cuando una orden con asesor se
--       vincula a una F1 que ya tiene hija, cierra la ventana de carrera
--       (draft completado antes de que la orden aterrizara con su tag).
--
-- RESOLUCIÓN DE LA ORDEN: canónicamente por shopify_order_id (unique por
-- org → 1:1). Fallback al vínculo orders.opportunity_id = F1 (toma la
-- primera orden con asesor). Si no hay orden con asesor → noop: el
-- fallback a la F1 ya es el estado correcto.
--
-- IDEMPOTENTE:
--   - Si el asesor de la orden ya coincide con el de la hija → noop.
--   - Re-correr no corrompe (lee orden, compara, escribe solo si difiere).
--
-- NO PISA REASIGNACIONES MANUALES: si existe un evento de audit_log que
-- indique reasignación manual de asesor (actor humano) sobre ESTA hija,
-- se salta (status 'manual_reassignment_detected'). Hoy NO existe feature
-- de reasignación de oportunidad en la app, así que esta guarda nunca
-- matchea — toda hija con asesor no-NULL lo tiene por herencia del trigger
-- (no por acción humana), de modo que pisarlo con el asesor de la orden es
-- correcto por la decisión de negocio. La guarda queda como defensa para
-- cuando V2 introduzca reasignación manual de opps. Ver ERRORES.md.
--
-- DRY-RUN (p_dry_run = true): reporta from/to SIN escribir (retorna antes
-- de cualquier UPDATE/INSERT, incluido el audit).
--
-- ATOMICIDAD: en modo live, UPDATE + audit en la misma invocación. Sin
-- EXCEPTION → todo-o-nada.
--
-- R2 / independencia: solo toca el asesor de la HIJA. Nunca escribe a la
-- F1 ni al contacto.
-- ============================================================
create or replace function public.reattribute_postventa_child_advisor(
  p_child_id uuid,
  p_dry_run  boolean default false,
  p_source   text default 'reattribution'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_child         public.opportunities%rowtype;
  v_parent        public.opportunities%rowtype;
  v_order_advisor uuid;
  v_order_id      text;
  v_manual        boolean;
  v_from          uuid;
  v_to            uuid;
begin
  select * into v_child
    from public.opportunities
   where id = p_child_id
   for update;
  if not found then
    return jsonb_build_object(
      'status', 'skipped', 'reason', 'child_not_found',
      'child_opportunity_id', p_child_id);
  end if;

  -- Solo aplica a hijas de Post-venta con madre.
  if v_child.funnel <> 'post_venta' or v_child.parent_opportunity_id is null then
    return jsonb_build_object(
      'status', 'skipped', 'reason', 'not_postventa_child',
      'child_opportunity_id', v_child.id);
  end if;

  select * into v_parent
    from public.opportunities
   where id = v_child.parent_opportunity_id;
  if not found then
    return jsonb_build_object(
      'status', 'skipped', 'reason', 'parent_not_found',
      'child_opportunity_id', v_child.id);
  end if;

  -- Resolver la orden: por shopify_order_id (canónico), fallback al
  -- vínculo orders.opportunity_id = F1 (orden con asesor).
  v_order_advisor := null;
  v_order_id      := null;
  if v_child.shopify_order_id is not null then
    select assigned_advisor_id, shopify_order_id
      into v_order_advisor, v_order_id
      from public.orders
     where organization_id = v_child.organization_id
       and shopify_order_id = v_child.shopify_order_id
     limit 1;
  end if;
  if v_order_advisor is null then
    select assigned_advisor_id, shopify_order_id
      into v_order_advisor, v_order_id
      from public.orders
     where organization_id = v_child.organization_id
       and opportunity_id = v_parent.id
       and assigned_advisor_id is not null
     order by created_at asc
     limit 1;
  end if;

  -- Sin orden con asesor → el fallback a la F1 ya es correcto. Noop.
  if v_order_advisor is null then
    return jsonb_build_object(
      'status', 'noop', 'reason', 'order_has_no_advisor',
      'child_opportunity_id', v_child.id,
      'parent_opportunity_id', v_parent.id);
  end if;

  -- Ya alineado → noop (idempotente).
  if v_order_advisor is not distinct from v_child.assigned_advisor_id then
    return jsonb_build_object(
      'status', 'noop', 'reason', 'already_aligned',
      'child_opportunity_id', v_child.id,
      'parent_opportunity_id', v_parent.id,
      'order_shopify_order_id', v_order_id,
      'advisor_id', v_order_advisor);
  end if;

  -- Guarda anti-reasignación-manual (defensa futura, ver cabecera).
  select exists(
    select 1 from public.audit_log
     where entity_type = 'opportunity'
       and entity_id = v_child.id
       and event_type in ('opportunity_advisor_reassigned', 'opportunity_reassigned')
       and actor_user_id is not null
  ) into v_manual;
  if v_manual then
    return jsonb_build_object(
      'status', 'skipped', 'reason', 'manual_reassignment_detected',
      'child_opportunity_id', v_child.id,
      'parent_opportunity_id', v_parent.id);
  end if;

  v_from := v_child.assigned_advisor_id;
  v_to   := v_order_advisor;

  -- Dry-run: reportar sin escribir.
  if p_dry_run then
    return jsonb_build_object(
      'status', 'would_fix',
      'child_opportunity_id', v_child.id,
      'parent_opportunity_id', v_parent.id,
      'order_shopify_order_id', v_order_id,
      'from_advisor_id', v_from,
      'to_advisor_id', v_to);
  end if;

  update public.opportunities
     set assigned_advisor_id = v_to,
         last_modified_at     = now(),
         last_modified_source = 'platform'
   where id = v_child.id;

  insert into public.audit_log
    (organization_id, actor_user_id, event_type, entity_type, entity_id, payload)
  values
    (v_child.organization_id, null, 'postventa_child_advisor_reattributed',
     'opportunity', v_child.id,
     jsonb_build_object(
       'parent_opportunity_id', v_parent.id,
       'order_shopify_order_id', v_order_id,
       'from_advisor_id', v_from,
       'to_advisor_id', v_to,
       'source', p_source));

  return jsonb_build_object(
    'status', 'fixed',
    'child_opportunity_id', v_child.id,
    'parent_opportunity_id', v_parent.id,
    'order_shopify_order_id', v_order_id,
    'from_advisor_id', v_from,
    'to_advisor_id', v_to);
end;
$$;

revoke execute on function public.reattribute_postventa_child_advisor(uuid, boolean, text)
  from public, anon, authenticated;
grant  execute on function public.reattribute_postventa_child_advisor(uuid, boolean, text)
  to service_role;
