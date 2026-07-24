-- ============================================================
-- Outbound · 0042 — trigger_f1_to_f2 hereda is_outbound a la hija
-- ============================================================
-- Re-CREATE de la definición CANÓNICA vigente (0027), preservando sus
-- CUATRO invariantes (INV-1 comercial, INV-2 line items, INV-3 asesor
-- coalesce, INV-4 fecha real). ÚNICO delta: la hija de Post-venta hereda
-- `is_outbound` de la F1 (INV-5, Fase 1 de Outbound) — una opp de Venta
-- marcada outbound propaga la marca a su hija de Post-venta al cerrarse la
-- venta, para que las métricas outbound/inbound sean consistentes en todo
-- el ciclo. En Fase 1 todas las opps son is_outbound=false, así que el
-- cambio es inerte hasta que la Fase 2 empiece a marcar contactos; se
-- cablea aquí para que el trigger nazca correcto antes de esa fase.
--
-- El test estático tests/f1-to-f2-trigger-sql-contract.test.ts auto-rastrea
-- la migración de mayor número que redefine el trigger (ahora ésta) y
-- asierta las invariantes en CI. Ver ERRORES.md "create or replace
-- reemplaza el cuerpo ENTERO": este cuerpo es la UNIÓN completa de 0027 +
-- la herencia de is_outbound, NO un parche sobre una versión vieja.
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
  v_order_created  timestamptz;
  v_won_at         timestamptz;
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

  -- (B) Asesor de la hija: el de la ORDEN cerrada cuando la orden tiene
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

  -- (C) Fecha real de ganada = created_at del pedido en Shopify (0024).
  -- Si el pedido aún no aterrizó (carrera en vivo) → now() (≈ tiempo
  -- real en vivo; el correctivo/M11 reescribe el caso bulk).
  v_order_created := null;
  if p_shopify_order_id is not null then
    select shopify_created_at into v_order_created
      from public.orders
     where organization_id = v_f1.organization_id
       and shopify_order_id = p_shopify_order_id
     limit 1;
  end if;
  v_won_at := coalesce(v_order_created, now());

  -- 1) F1 → Ganada + won_at (fecha real del pedido) + shopify_order_id.
  --    coalesce preserva won_at/shopify_order_id si ya estaban (F1
  --    ganada manualmente antes de la completación del draft).
  update public.opportunities
     set stage_id             = v_won_stage.id,
         won_at               = coalesce(won_at, v_won_at),
         shopify_order_id     = coalesce(shopify_order_id, p_shopify_order_id),
         last_modified_at     = now(),
         last_modified_source = 'platform'
   where id = v_f1.id;

  -- 2) Historial de la F1 (Ganada) — solo si hubo cambio real de etapa.
  --    shopify_event_at = fecha real del pedido (NULL si no resuelto →
  --    la columna generada cae a changed_at).
  if v_from_stage is distinct from v_won_stage.id then
    insert into public.opportunity_stage_history
      (organization_id, opportunity_id, from_stage_id, to_stage_id,
       changed_by_user_id, context, shopify_event_at)
    values
      (v_f1.organization_id, v_f1.id, v_from_stage, v_won_stage.id,
       null, 'trigger_f1_f2', v_order_created);
  end if;

  -- 3) Hija en Post-venta inicial. Hereda contacto + asesor de la ORDEN
  --    (fallback F1) (B) + datos comerciales de la F1 (A): monto
  --    real/estimado, order_id y referencia visible + is_outbound (INV-5).
  --    NO hereda shopify_draft_order_id (ver cabezal 0027: unique
  --    constraint + lookup).
  insert into public.opportunities
    (organization_id, funnel, stage_id, contact_id, assigned_advisor_id,
     parent_opportunity_id, currency,
     actual_amount, estimated_amount, shopify_order_id, display_reference,
     is_outbound,
     last_modified_at, last_modified_source)
  values
    (v_f1.organization_id, 'post_venta', v_initial_pv.id, v_f1.contact_id,
     v_child_advisor, v_f1.id, v_f1.currency,
     v_f1.actual_amount, v_f1.estimated_amount, v_child_order_id,
     v_f1.display_reference,
     v_f1.is_outbound,
     now(), 'platform')
  returning id into v_child_id;

  -- 3b) Line items — copia 1:1 desde la F1 a la hija, dentro del mismo
  --     RPC (atómico) (A). Solo en el nacimiento de la hija, así que no
  --     hay riesgo de duplicado por idempotencia.
  insert into public.opportunity_line_items
    (organization_id, opportunity_id, shopify_product_id, shopify_variant_id,
     title, sku, quantity, variant_title, original_unit_price,
     discount_amount, final_price, weight_grams, taxable)
  select organization_id, v_child_id, shopify_product_id, shopify_variant_id,
     title, sku, quantity, variant_title, original_unit_price,
     discount_amount, final_price, weight_grams, taxable
    from public.opportunity_line_items
   where opportunity_id = v_f1.id;

  -- 4) Historial de la hija (nacimiento) — shopify_event_at = fecha real
  --    del pedido (la hija nace en el momento del cierre de la venta).
  insert into public.opportunity_stage_history
    (organization_id, opportunity_id, from_stage_id, to_stage_id,
     changed_by_user_id, context, shopify_event_at)
  values
    (v_f1.organization_id, v_child_id, null, v_initial_pv.id,
     null, 'trigger_f1_f2', v_order_created);

  return jsonb_build_object(
    'status', 'fired', 'reason', null, 'child_opportunity_id', v_child_id);
end;
$$;
