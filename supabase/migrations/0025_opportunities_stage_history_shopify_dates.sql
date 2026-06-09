-- ============================================================
-- Fix crítico · 0025 — fecha real de Shopify en opportunities y
-- opportunity_stage_history (ampliación del fix 0024 de orders).
-- ============================================================
-- El dashboard contaba varios KPIs por periodo usando la fecha en que
-- el registro entró a la BD (created_at / changed_at / won_at = now()
-- al importar), no por la fecha real en que el hecho ocurrió en Shopify.
-- 0024 lo resolvió para orders; esta migración lo amplía a las dos
-- entidades restantes que el dashboard reporta por periodo:
--
--   1) opportunities.created_at  → Cotizaciones enviadas, inicio de
--      Sales cycle, filtro Pipeline/Activas.
--   2) opportunities.won_at      → Ganadas, Win/Loss, fin de Sales cycle.
--   3) opportunity_stage_history.changed_at → Leads, Calificados,
--      Perdidas, Win rate por etapa.
--
-- PRINCIPIO (validado contra el código): un registro PROVENIENTE de
-- Shopify se ubica en el tiempo por su fecha real de Shopify; un
-- registro NACIDO en la plataforma (lead R12 sin draft, win manual,
-- arrastre manual de etapa) conserva su fecha propia. Por eso, a
-- diferencia de orders (todas son de Shopify → se excluye NULL), aquí
-- la fecha efectiva es COALESCE(fecha_shopify, fecha_plataforma):
-- materializada como columnas generadas para poder filtrar/indexar.
--
-- NULL-handling: las filas pre-fix quedan con la columna shopify_*
-- en NULL hasta el correctivo; la columna generada cae al created_at /
-- changed_at de plataforma (el dato viejo) — el dashboard sigue
-- mostrándolas en su periodo de importación hasta correr el correctivo,
-- exactamente como el operador ya validó para orders. won_at se corrige
-- in situ (es semánticamente "la fecha de ganada", no un eje paralelo).
-- ============================================================

-- ------------------------------------------------------------
-- 1) opportunities.shopify_created_at  (created_at del Draft Order
--    en Shopify — la fecha real en que se generó la Cotización).
--    Nullable: NULL para opps nacidas en plataforma (lead R12, manual)
--    que nunca tuvieron Draft Order. El mapper de draft orders ya
--    extrae normalized.createdAt; el worker ahora lo persiste.
-- ------------------------------------------------------------
alter table public.opportunities
  add column shopify_created_at timestamptz;

comment on column public.opportunities.shopify_created_at is
  'created_at del Draft Order en Shopify (fecha real de creación de la Cotización). NULL para opps nacidas en plataforma sin draft (lead R12, manual). Distinto de created_at (entrada a la BD). El dashboard cuenta por effective_created_at, no por created_at.';

-- Columna generada: fecha efectiva para ubicar la opp en el tiempo.
-- Shopify si existe, si no la fecha de nacimiento en plataforma.
alter table public.opportunities
  add column effective_created_at timestamptz
    generated always as (coalesce(shopify_created_at, created_at)) stored;

comment on column public.opportunities.effective_created_at is
  'COALESCE(shopify_created_at, created_at). Eje temporal real de la opp para el dashboard (Cotizaciones, inicio de Sales cycle, Pipeline/Activas). Generada stored para filtrar/indexar.';

create index opportunities_org_effective_created_at_idx
  on public.opportunities (organization_id, effective_created_at desc);

-- ------------------------------------------------------------
-- 2) opportunity_stage_history.shopify_event_at  (fecha real del
--    evento de Shopify detrás de la entrada de etapa).
--    Poblada SOLO para entradas de origen Shopify (context 'webhook'
--    = entrada a Cotización por el Draft Order; context 'trigger_f1_f2'
--    = Ganada por completación del draft). Las entradas de origen
--    humano/plataforma (context 'manual', etc.) la dejan NULL → la
--    columna generada cae a changed_at (que ES la verdad para ellas).
-- ------------------------------------------------------------
alter table public.opportunity_stage_history
  add column shopify_event_at timestamptz;

comment on column public.opportunity_stage_history.shopify_event_at is
  'Fecha real del evento de Shopify detrás de la entrada de etapa (DO created_at para Cotización vía webhook; fecha del pedido para Ganada vía trigger). NULL para entradas de origen plataforma (manual). El dashboard ubica por effective_event_at.';

alter table public.opportunity_stage_history
  add column effective_event_at timestamptz
    generated always as (coalesce(shopify_event_at, changed_at)) stored;

comment on column public.opportunity_stage_history.effective_event_at is
  'COALESCE(shopify_event_at, changed_at). Eje temporal real de la entrada de etapa para el dashboard (Leads, Calificados, Perdidas, Win rate por etapa). Generada stored para filtrar/indexar.';

create index opportunity_stage_history_org_to_stage_effective_idx
  on public.opportunity_stage_history (organization_id, to_stage_id, effective_event_at);

-- ------------------------------------------------------------
-- 3) Relajación quirúrgica de la inmutabilidad de stage_history.
--    El correctivo necesita poblar shopify_event_at en filas
--    existentes, pero changed_at (el audit trail "cuándo lo
--    registramos") y todo lo demás siguen inmutables. DELETE sigue
--    bloqueado. Reemplaza el trigger genérico tg_block_mutation por
--    una guarda que permite UPDATE SOLO si el único cambio es
--    shopify_event_at.
-- ------------------------------------------------------------
create or replace function public.tg_stage_history_shopify_event_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'immutable_table: opportunity_stage_history no acepta DELETE (audit trail)'
      using errcode = 'P0001';
  end if;
  -- UPDATE permitido SOLO si el único campo que cambia es shopify_event_at.
  -- (is distinct from sobre el row de campos inmutables maneja NULLs.)
  if (OLD.id, OLD.organization_id, OLD.opportunity_id, OLD.from_stage_id,
      OLD.to_stage_id, OLD.changed_by_user_id, OLD.context, OLD.changed_at)
     is distinct from
     (NEW.id, NEW.organization_id, NEW.opportunity_id, NEW.from_stage_id,
      NEW.to_stage_id, NEW.changed_by_user_id, NEW.context, NEW.changed_at)
  then
    raise exception 'immutable_table: opportunity_stage_history solo permite actualizar shopify_event_at (audit trail)'
      using errcode = 'P0001';
  end if;
  return NEW;
end;
$$;

drop trigger if exists opportunity_stage_history_no_update
  on public.opportunity_stage_history;

create trigger opportunity_stage_history_guard
  before update or delete on public.opportunity_stage_history
  for each row execute function public.tg_stage_history_shopify_event_guard();

-- ------------------------------------------------------------
-- 4) Trigger F1→F2: poblar won_at y shopify_event_at de la Ganada
--    con la fecha REAL del pedido vinculado (orders.shopify_created_at),
--    no con now(). Resuelve el pedido si ya está en la BD; si no
--    (carrera de webhooks en vivo), cae a now() — en vivo now() ≈
--    tiempo real, y el correctivo / M11 (que importa el pedido antes)
--    cierra el caso bulk. Re-CREATE de la función de 0020 con este
--    único cambio + shopify_event_at en las entradas de historial.
-- ------------------------------------------------------------
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
  v_order_created  timestamptz;
  v_won_at         timestamptz;
begin
  select * into v_f1
    from public.opportunities
   where id = p_opportunity_id
   for update;
  if not found then
    return jsonb_build_object(
      'status', 'skipped', 'reason', 'f1_not_found', 'child_opportunity_id', null);
  end if;

  if v_f1.funnel <> 'venta' or v_f1.parent_opportunity_id is not null then
    return jsonb_build_object(
      'status', 'skipped', 'reason', 'precondition_not_venta_parent',
      'child_opportunity_id', null);
  end if;

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

  -- Fecha real de ganada = created_at del pedido en Shopify (0024).
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
  update public.opportunities
     set stage_id             = v_won_stage.id,
         won_at               = coalesce(won_at, v_won_at),
         shopify_order_id     = coalesce(shopify_order_id, p_shopify_order_id),
         last_modified_at     = now(),
         last_modified_source = 'platform'
   where id = v_f1.id;

  -- 2) Historial de la F1 (Ganada) — shopify_event_at = fecha real del
  --    pedido (NULL si no resuelto → la generada cae a changed_at).
  if v_from_stage is distinct from v_won_stage.id then
    insert into public.opportunity_stage_history
      (organization_id, opportunity_id, from_stage_id, to_stage_id,
       changed_by_user_id, context, shopify_event_at)
    values
      (v_f1.organization_id, v_f1.id, v_from_stage, v_won_stage.id,
       null, 'trigger_f1_f2', v_order_created);
  end if;

  -- 3) Hija en Post-venta inicial, heredando contacto + asesor (R2).
  insert into public.opportunities
    (organization_id, funnel, stage_id, contact_id, assigned_advisor_id,
     parent_opportunity_id, currency, last_modified_at, last_modified_source)
  values
    (v_f1.organization_id, 'post_venta', v_initial_pv.id, v_f1.contact_id,
     v_f1.assigned_advisor_id, v_f1.id, v_f1.currency, now(), 'platform')
  returning id into v_child_id;

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

revoke execute on function public.trigger_f1_to_f2(uuid, text)
  from public, anon, authenticated;
grant  execute on function public.trigger_f1_to_f2(uuid, text)
  to service_role;
