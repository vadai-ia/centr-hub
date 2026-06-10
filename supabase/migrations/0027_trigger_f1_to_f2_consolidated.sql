-- ============================================================
-- Fix de regresión · 0027 — Definición CANÓNICA ÚNICA del trigger
-- F1→F2: consolida las TRES preocupaciones acumuladas.
-- ============================================================
-- REGRESIÓN corregida: la migración 0025 (fechas reales de Shopify)
-- re-CREATE `trigger_f1_to_f2` rebasándose sobre la versión 0020
-- ("Re-CREATE de la función de 0020 con este único cambio" — su propio
-- cabezal). Al hacerlo BORRÓ silenciosamente lo que 0021 y 0022 habían
-- agregado al INSERT de la hija:
--   · 0021 — herencia de datos comerciales (actual_amount,
--     estimated_amount, shopify_order_id, display_reference) + line items.
--   · 0022 — asesor de la hija = coalesce(asesor_orden, asesor_F1).
-- Resultado en BD: desde el deploy de 0025, cada hija de Post-venta nace
-- pelada (montos/order_id/referencia/line items en NULL). El asesor
-- también se regresó en el trigger, pero quedó ENMASCARADO por el hook
-- de orders/* (reattribute_postventa_child_advisor, 0022) que lo rellena
-- al aterrizar la orden; la herencia comercial NO tenía hook equivalente
-- → quedó 100% expuesta. Ver ERRORES.md "Regresión: 0025 pisó la
-- herencia comercial de la hija (0021) al re-CREATE el trigger F1→F2".
--
-- ESTA MIGRACIÓN es la definición CANÓNICA del trigger. Carga la UNIÓN
-- de las tres preocupaciones, en un solo cuerpo:
--   (A) DATOS COMERCIALES + LINE ITEMS (de 0021): la hija hereda
--       actual_amount, estimated_amount, shopify_order_id (= el order id
--       efectivo de la venta), display_reference, y copia 1:1 los line
--       items de la F1 dentro del mismo RPC atómico.
--   (B) ASESOR DE LA ORDEN (de 0022): la hija nace con
--       coalesce(asesor_orden, asesor_F1). El hook de orders/* sigue
--       siendo la RED para la carrera de webhooks (draft completado
--       antes de que la orden aterrice con su tag), pero el trigger ya
--       nace correcto cuando la orden está presente.
--   (C) FECHA REAL DE SHOPIFY (de 0025): won_at y los shopify_event_at
--       de las entradas de historial = orders.shopify_created_at del
--       pedido vinculado; fallback a now() si el pedido aún no aterrizó.
--
-- DECISIÓN DE DISEÑO — shopify_draft_order_id NO se hereda (de 0021):
--   La columna tiene unique (organization_id, shopify_draft_order_id)
--   (0004). Copiarla a la hija violaría la unicidad y ABORTARÍA el RPC
--   atómico (la hija nunca nacería). Además findOpportunityByDraftOrderId
--   usa .maybeSingle() sin filtrar funnel: dos filas con el mismo draft
--   id lo harían fallar y romperían la idempotencia de los webhooks
--   draft_orders/* posteriores. La referencia visible vive en
--   display_reference (texto sin constraint); la trazabilidad al draft
--   se mantiene vía parent_opportunity_id → F1.
--
-- ATOMICIDAD: toda la herencia (scalars + line items + historial) ocurre
-- dentro del mismo RPC sin bloque EXCEPTION. Cualquier fallo → Postgres
-- revierte TODO. No hay estado intermedio.
--
-- IDEMPOTENCIA: el guard child_already_exists impide una segunda hija;
-- los line items se copian una sola vez (en el nacimiento). coalesce en
-- el UPDATE de la F1 preserva won_at/shopify_order_id si ya estaban.
--
-- R2 (asignación de origen): la hija se toca UNA sola vez al nacer; el
-- RPC no vuelve a escribirla. Reasignaciones posteriores de la F1 no se
-- propagan. La re-atribución posterior la dispara la ORDEN vía hook.
--
-- ============================================================
-- ⚠ CONTRATO DE INVARIANTES — LEER ANTES DE RE-CREATE ⚠
-- Toda redefinición futura de trigger_f1_to_f2 DEBE preservar las cuatro
-- invariantes de abajo. Un re-CREATE que suelte cualquiera es una
-- regresión (es exactamente lo que pasó con 0025). El test estático
-- tests/f1-to-f2-trigger-sql-contract.test.ts auto-rastrea la migración
-- de mayor número que redefine el trigger y asierta que su cuerpo las
-- contiene — no hay puntero que mantener: si agregás una migración que
-- re-CREATE el trigger y suelta cualquiera, la suite falla en CI sola.
--   INV-1 (comercial): el INSERT de la hija incluye actual_amount,
--          estimated_amount, shopify_order_id y display_reference.
--   INV-2 (line items): hay un INSERT-SELECT de opportunity_line_items
--          desde la F1 hacia la hija.
--   INV-3 (asesor): el asesor de la hija = coalesce(asesor_orden, F1),
--          NO v_f1.assigned_advisor_id directo.
--   INV-4 (fecha real): won_at y shopify_event_at se resuelven desde
--          orders.shopify_created_at (fallback now()).
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
  --    real/estimado, order_id y referencia visible. NO hereda
  --    shopify_draft_order_id (ver cabezal: unique constraint + lookup).
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

-- Solo el service_role (workers Inngest) invoca este RPC.
revoke execute on function public.trigger_f1_to_f2(uuid, text)
  from public, anon, authenticated;
grant  execute on function public.trigger_f1_to_f2(uuid, text)
  to service_role;
