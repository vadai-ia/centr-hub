-- ============================================================
-- Fix M7.2 · 0021 — La hija F2 (Post-venta) hereda los datos
-- comerciales de la F1 madre en el trigger atómico
-- ============================================================
-- BUG corregido: el trigger 0020 creaba la hija de Post-venta SOLO
-- con contacto, asesor, parent y currency. Los datos comerciales
-- (monto, order_id, referencia visible, line items) quedaban en NULL
-- → la hija nacía como un cascarón sin la información de su madre.
-- Confirmado en BD: hijas en "Cotización completada" con
-- actual_amount / estimated_amount / shopify_order_id en NULL aunque
-- la F1 madre mostrara monto ($773,749) y referencia (#D493).
--
-- ESTE FIX:
--   1) trigger_f1_to_f2: la hija ahora HEREDA en el mismo INSERT
--      atómico: actual_amount, estimated_amount, shopify_order_id,
--      display_reference, y los line items (INSERT-SELECT desde la F1).
--   2) backfill_f1_to_f2_child: RPC nueva que rellena hijas YA
--      existentes (creadas antes del fix) reusando exactamente el
--      mismo conjunto de campos y semántica — para que queden
--      idénticas a las que nacerán bien de ahora en adelante.
--
-- DECISIÓN DE DISEÑO — shopify_draft_order_id NO se hereda:
--   La columna tiene unique (organization_id, shopify_draft_order_id)
--   (migración 0004). Copiarla a la hija violaría esa unicidad y
--   ABORTARÍA el RPC atómico (la hija nunca nacería). Además
--   findOpportunityByDraftOrderId usa .maybeSingle() sin filtrar
--   funnel: dos filas con el mismo draft id lo harían fallar y
--   romperían la idempotencia de todos los webhooks draft_orders/*
--   posteriores. La referencia visible (#D...) vive en
--   display_reference (texto sin constraint), así que la hija la
--   muestra igual; la trazabilidad al draft se mantiene vía
--   parent_opportunity_id → F1.
--
-- ATOMICIDAD: se preserva — toda la herencia (scalars + line items)
-- ocurre dentro del mismo RPC sin bloque EXCEPTION. Si cualquier
-- paso falla, Postgres revierte TODO. No hay estado intermedio.
--
-- IDEMPOTENCIA: se preserva — el guard child_already_exists impide
-- una segunda hija; los line items se copian una sola vez (en el
-- nacimiento de la hija). El correctivo es idempotente por
-- construcción (ver backfill_f1_to_f2_child).
--
-- R2 (asignación de origen): la hija sigue heredando
-- assigned_advisor_id de la F1 UNA sola vez; el RPC no vuelve a
-- tocar la hija. Contacto/asesor/parent/currency intactos.
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

  -- 3) Hija en Post-venta inicial. Hereda contacto + asesor (R2) +
  --    datos comerciales de la F1 (monto real/estimado, order_id y
  --    referencia visible). NO hereda shopify_draft_order_id (ver
  --    cabecera: unique constraint + maybeSingle del lookup).
  insert into public.opportunities
    (organization_id, funnel, stage_id, contact_id, assigned_advisor_id,
     parent_opportunity_id, currency,
     actual_amount, estimated_amount, shopify_order_id, display_reference,
     last_modified_at, last_modified_source)
  values
    (v_f1.organization_id, 'post_venta', v_initial_pv.id, v_f1.contact_id,
     v_f1.assigned_advisor_id, v_f1.id, v_f1.currency,
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

-- Solo el service_role (workers Inngest) invoca este RPC.
revoke execute on function public.trigger_f1_to_f2(uuid, text)
  from public, anon, authenticated;
grant  execute on function public.trigger_f1_to_f2(uuid, text)
  to service_role;


-- ============================================================
-- backfill_f1_to_f2_child — correctivo de hijas pre-fix
-- ============================================================
-- Rellena una hija de Post-venta YA existente con los datos
-- comerciales de su F1 madre, usando EXACTAMENTE el mismo conjunto
-- de campos que el trigger arreglado. Pensado para corregir las
-- hijas creadas por el trigger viejo (datos en NULL).
--
-- IDEMPOTENTE:
--   - Scalars (actual_amount, estimated_amount, shopify_order_id,
--     display_reference): se rellenan vía coalesce — solo se escribe
--     el valor de la madre donde la hija tiene NULL. Re-correr no
--     pisa valores ya presentes.
--   - Line items: se copian SOLO si la hija no tiene ninguno. Si ya
--     tiene (corrida previa, o vino con datos), NO se vuelven a
--     insertar → cero duplicados en re-runs.
--
-- DRY-RUN (p_dry_run = true): calcula y devuelve qué cambiaría
-- (status 'would_fix' / 'noop') SIN escribir nada (retorna antes de
-- cualquier UPDATE/INSERT, incluido el audit).
--
-- ATOMICIDAD: en modo live, el UPDATE de scalars + la copia de line
-- items + el audit ocurren en la misma invocación (transacción del
-- statement). Sin bloque EXCEPTION → todo-o-nada.
--
-- AUDIT: cada hija efectivamente corregida emite
-- 'trigger_f1_f2_child_backfilled' en la misma transacción.
-- ============================================================
create or replace function public.backfill_f1_to_f2_child(
  p_child_id uuid,
  p_dry_run  boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_child           public.opportunities%rowtype;
  v_parent          public.opportunities%rowtype;
  v_child_li_count  integer;
  v_parent_li_count integer;
  v_copy_line_items boolean;
  v_new_actual      numeric(12, 2);
  v_new_estimated   numeric(12, 2);
  v_new_order_id    text;
  v_new_ref         text;
  v_changed         boolean;
  v_changes         jsonb;
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

  -- Scalars: rellenar solo donde la hija tiene NULL (idempotente).
  v_new_actual    := coalesce(v_child.actual_amount, v_parent.actual_amount);
  v_new_estimated := coalesce(v_child.estimated_amount, v_parent.estimated_amount);
  v_new_order_id  := coalesce(v_child.shopify_order_id, v_parent.shopify_order_id);
  v_new_ref       := coalesce(v_child.display_reference, v_parent.display_reference);

  -- Line items: copiar solo si la hija no tiene ninguno y la madre sí.
  select count(*) into v_child_li_count
    from public.opportunity_line_items where opportunity_id = v_child.id;
  select count(*) into v_parent_li_count
    from public.opportunity_line_items where opportunity_id = v_parent.id;
  v_copy_line_items := (v_child_li_count = 0 and v_parent_li_count > 0);

  v_changed :=
       (v_new_actual    is distinct from v_child.actual_amount)
    or (v_new_estimated is distinct from v_child.estimated_amount)
    or (v_new_order_id  is distinct from v_child.shopify_order_id)
    or (v_new_ref       is distinct from v_child.display_reference)
    or v_copy_line_items;

  v_changes := jsonb_build_object(
    'actual_amount',
      jsonb_build_object('from', v_child.actual_amount, 'to', v_new_actual),
    'estimated_amount',
      jsonb_build_object('from', v_child.estimated_amount, 'to', v_new_estimated),
    'shopify_order_id',
      jsonb_build_object('from', v_child.shopify_order_id, 'to', v_new_order_id),
    'display_reference',
      jsonb_build_object('from', v_child.display_reference, 'to', v_new_ref),
    'line_items_to_copy',
      case when v_copy_line_items then v_parent_li_count else 0 end);

  -- Dry-run: reportar sin escribir.
  if p_dry_run then
    return jsonb_build_object(
      'status', case when v_changed then 'would_fix' else 'noop' end,
      'child_opportunity_id', v_child.id,
      'parent_opportunity_id', v_parent.id,
      'changes', v_changes);
  end if;

  -- Nada que cambiar → no-op (idempotente).
  if not v_changed then
    return jsonb_build_object(
      'status', 'noop',
      'child_opportunity_id', v_child.id,
      'parent_opportunity_id', v_parent.id);
  end if;

  update public.opportunities
     set actual_amount        = v_new_actual,
         estimated_amount     = v_new_estimated,
         shopify_order_id     = v_new_order_id,
         display_reference    = v_new_ref,
         last_modified_at     = now(),
         last_modified_source = 'platform'
   where id = v_child.id;

  if v_copy_line_items then
    insert into public.opportunity_line_items
      (organization_id, opportunity_id, shopify_product_id, shopify_variant_id,
       title, sku, quantity, variant_title, original_unit_price,
       discount_amount, final_price, weight_grams, taxable)
    select organization_id, v_child.id, shopify_product_id, shopify_variant_id,
       title, sku, quantity, variant_title, original_unit_price,
       discount_amount, final_price, weight_grams, taxable
      from public.opportunity_line_items
     where opportunity_id = v_parent.id;
  end if;

  insert into public.audit_log
    (organization_id, actor_user_id, event_type, entity_type, entity_id, payload)
  values
    (v_child.organization_id, null, 'trigger_f1_f2_child_backfilled',
     'opportunity', v_child.id,
     jsonb_build_object(
       'parent_opportunity_id', v_parent.id,
       'changes', v_changes));

  return jsonb_build_object(
    'status', 'fixed',
    'child_opportunity_id', v_child.id,
    'parent_opportunity_id', v_parent.id,
    'line_items_copied',
      case when v_copy_line_items then v_parent_li_count else 0 end);
end;
$$;

revoke execute on function public.backfill_f1_to_f2_child(uuid, boolean)
  from public, anon, authenticated;
grant  execute on function public.backfill_f1_to_f2_child(uuid, boolean)
  to service_role;
